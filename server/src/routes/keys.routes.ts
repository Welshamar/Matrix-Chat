import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { fetchPreKeyBundle, uploadPreKeyBundle } from "../controllers/keys.controller";

const router = Router();

router.post("/prekey-bundle", requireAuth, uploadPreKeyBundle);
router.get("/prekey-bundle/:userId", requireAuth, fetchPreKeyBundle);

export default router;
