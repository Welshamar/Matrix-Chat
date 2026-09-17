import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/asyncHandler";
import {
  login,
  lookupUsername,
  register,
  resendCode,
  resolveUserId,
  updateProfile,
  verifyEmail,
} from "../controllers/auth.controller";

const router = Router();

router.post("/register", asyncHandler(register));
router.post("/verify-email", asyncHandler(verifyEmail));
router.post("/resend-code", asyncHandler(resendCode));
router.post("/login", asyncHandler(login));
router.get("/lookup/:username", requireAuth, asyncHandler(lookupUsername));
router.get("/resolve/:userId", requireAuth, asyncHandler(resolveUserId));
router.patch("/profile", requireAuth, asyncHandler(updateProfile));

export default router;
