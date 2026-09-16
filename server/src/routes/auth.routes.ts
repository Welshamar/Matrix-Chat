import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { login, lookupUsername, register, resolveUserId, updateProfile } from "../controllers/auth.controller";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.get("/lookup/:username", requireAuth, lookupUsername);
router.get("/resolve/:userId", requireAuth, resolveUserId);
router.patch("/profile", requireAuth, updateProfile);

export default router;
