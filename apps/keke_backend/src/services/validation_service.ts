import { z } from "zod";

/**
 * Driver Onboarding Schema
 */
export const driverOnboardingSchema = z.object({
  userId: z.string().min(1, "User ID is required").optional(),
  firstName: z.string().min(2, "First name must be at least 2 characters"),
  lastName: z.string().min(2, "Last name must be at least 2 characters"),
  vehiclePlate: z.string().min(4, "Invalid vehicle plate"),
  vehicleModel: z.string().min(2, "Invalid vehicle model"),
});

/**
 * Admin Rejection Schema
 * Rejection MUST require a non-empty reason.
 */
export const adminRejectionSchema = z.object({
  reason: z.string().min(4, "A descriptive rejection reason is required (min 4 chars)"),
});

/**
 * Admin Approval Schema
 */
export const adminApprovalSchema = z.object({
  userId: z.string().optional(), // Often in params, not body
});
