import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const PARTNER_ID = process.env.SMILE_ID_PARTNER_ID || "placeholder_partner_id";
const API_KEY = process.env.SMILE_ID_API_KEY || "placeholder_api_key";
const USE_SANDBOX = process.env.SMILE_ID_USE_SANDBOX !== "false"; // default to true

export interface VerificationResult {
    success: boolean;
    reason?: string;
    retrievedName?: string;
}

export class SmileIdService {
    /**
     * Generate security signature for Smile ID requests
     */
    static generateSignature(timestamp: string): string {
        const message = `${timestamp}${PARTNER_ID}sid_request`;
        return crypto
            .createHmac("sha256", API_KEY)
            .update(message)
            .digest("base64");
    }

    /**
     * Validate NIN against NIMC database and match with driver names
     */
    static async verifyNIN(
        userId: string,
        nin: string,
        profileFirstName: string,
        profileLastName: string
    ): Promise<VerificationResult> {
        // If keys are placeholder (e.g. in local development without real keys), simulate a successful verification for testing
        if (PARTNER_ID === "placeholder_partner_id" || API_KEY === "placeholder_api_key") {
            console.warn("[SMILE_ID] Placeholder keys detected. Simulating successful verification.");
            return {
                success: true,
                retrievedName: `${profileFirstName} ${profileLastName}`
            };
        }

        const timestamp = new Date().toISOString();
        const signature = this.generateSignature(timestamp);

        // Determine correct base URL (sandbox/preprod vs production)
        const baseUrl = USE_SANDBOX
            ? "https://testapi.smileidentity.com/v1"
            : "https://api.usesmileid.com/v1";

        const jobId = `NIN-${userId}-${Date.now()}`;

        // Standard request payload for Enhanced KYC (Job Type 5)
        const payload = {
            partner_id: PARTNER_ID,
            timestamp: timestamp,
            signature: signature,
            country: "NG",
            id_type: nin.length === 11 ? "NIN" : "VIRTUAL_NIN",
            id_number: nin,
            partner_params: {
                user_id: userId,
                job_id: jobId,
                job_type: 5
            }
        };

        try {
            const response = await axios.post(`${baseUrl}/id_verification`, payload, {
                headers: {
                    "Content-Type": "application/json"
                },
                timeout: 15000 // 15 seconds timeout
            });

            const data = response.data;

            // Smile ID status check
            const isApproved = 
                data.ResultCode === "1012" || // Approved (Document/ID Matches database)
                data.ResultCode === "1015" ||
                data.ResultText?.toLowerCase()?.includes("approved") ||
                data.ResultText?.toLowerCase()?.includes("match") ||
                data.Actions?.Verify_ID_No?.toLowerCase() === "verified";

            if (!isApproved) {
                return {
                    success: false,
                    reason: data.ResultText || "ID verification rejected by provider."
                };
            }

            // Extract names from result fields
            const retrievedFirstName = (data.FirstName || data.Firstname || "").toString().trim().toLowerCase();
            const retrievedLastName = (data.LastName || data.Surname || data.Lastname || "").toString().trim().toLowerCase();
            const retrievedFullName = (data.FullName || data.Fullname || "").toString().trim().toLowerCase();

            const pFirst = profileFirstName.trim().toLowerCase();
            const pLast = profileLastName.trim().toLowerCase();

            // Perform robust name matching
            let isNameMatch = false;

            if (retrievedFirstName && retrievedLastName) {
                // Direct match or word inclusion match
                const firstMatches = retrievedFirstName.includes(pFirst) || pFirst.includes(retrievedFirstName);
                const lastMatches = retrievedLastName.includes(pLast) || pLast.includes(retrievedLastName);
                isNameMatch = firstMatches && lastMatches;
            } else if (retrievedFullName) {
                // If only FullName is returned
                isNameMatch = retrievedFullName.includes(pFirst) && retrievedFullName.includes(pLast);
            }

            // Fallback fuzzy name check: check if first and last name appear anywhere in the response text
            if (!isNameMatch) {
                const responseString = JSON.stringify(data).toLowerCase();
                isNameMatch = responseString.includes(pFirst) && responseString.includes(pLast);
            }

            if (!isNameMatch) {
                return {
                    success: false,
                    reason: `Name mismatch. Driver name: ${profileFirstName} ${profileLastName}, but ID database returned: ${data.FullName || (data.FirstName + " " + data.LastName)}`,
                    retrievedName: data.FullName || `${data.FirstName} ${data.LastName}`
                };
            }

            return {
                success: true,
                retrievedName: data.FullName || `${data.FirstName} ${data.LastName}`
            };

        } catch (error: any) {
            console.error("[SMILE_ID] Verification API Error:", error?.response?.data || error?.message);
            const errMsg = error?.response?.data?.error || error?.response?.data?.message || error?.message;
            return {
                success: false,
                reason: errMsg || "Identity verification server is currently unreachable. Please try again."
            };
        }
    }
}
