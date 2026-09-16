import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/asyncHandler";
import { fetchPreKeyBundle, uploadPreKeyBundle } from "../controllers/keys.controller";

const router = Router();

router.post("/prekey-bundle", requireAuth, asyncHandler(uploadPreKeyBundle));
router.get("/prekey-bundle/:userId", requireAuth, asyncHandler(fetchPreKeyBundle));

export default router;
