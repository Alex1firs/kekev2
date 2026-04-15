import multer from "multer";
import path from "path";
import fs from "fs";

/**
 * Configure storage for driver documents
 * Files are kept private in the local 'uploads' directory
 */
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, "../../uploads");
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        // Filename format: {userId}_{docType}_{timestamp}{ext}
        // DEFENSIVE: Sanitize and truncate userId to prevent ENAMETOOLONG or path injection
        let userId = req.body.userId || "anonymous";
        
        // Remove any non-alphanumeric or dash characters
        userId = userId.toString().replace(/[^a-zA-Z0-9-]/g, "");
        
        // Truncate to safe length (UUID is 36, let's allow 48 for safety)
        if (userId.length > 48) {
            userId = userId.substring(0, 48);
        }

        const docType = (req.body.docType || "unknown").toString().replace(/[^a-z0-9_]/g, "");
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname).toLowerCase();
        
        cb(null, `${userId}_${docType}_${uniqueSuffix}${ext}`);
    }
});

/**
 * File filter to enforce strict MIME/extension rules
 */
const fileFilter = (req: any, file: Express.Multer.File, cb: any) => {
    const allowedMimeTypes = ["image/jpeg", "image/png"];
    const allowedExtensions = [".jpg", ".jpeg", ".png"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error("Invalid file type. Only JPEG and PNG are allowed."), false);
    }
};

/**
 * Multer Instance
 */
export const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
    }
});
