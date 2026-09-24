import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/asyncHandler";
import {
  forgotPassword,
  login,
  lookupUsername,
  register,
  registerPushToken,
  resendCode,
  resetPassword,
  resolveUserId,
  updateProfile,
  verifyEmail,
} from "../controllers/auth.controller";

const router = Router();

router.post("/register", asyncHandler(register));
router.post("/verify-email", asyncHandler(verifyEmail));
router.post("/resend-code", asyncHandler(resendCode));
router.post("/login", asyncHandler(login));
router.post("/forgot-password", asyncHandler(forgotPassword));
router.post("/reset-password", asyncHandler(resetPassword));
router.get("/lookup/:username", requireAuth, asyncHandler(lookupUsername));
router.get("/resolve/:userId", requireAuth, asyncHandler(resolveUserId));
router.patch("/profile", requireAuth, asyncHandler(updateProfile));
router.post("/push-token", requireAuth, asyncHandler(registerPushToken));

export default router;
