import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/asyncHandler";
import {
  login,
  lookupUsername,
  register,
  registerPushToken,
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
router.post("/push-token", requireAuth, asyncHandler(registerPushToken));

export default router;
