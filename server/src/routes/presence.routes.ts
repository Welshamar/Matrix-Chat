import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/asyncHandler";
import { getPresence, getPresenceBatch } from "../controllers/presence.controller";

const router = Router();

router.get("/:userId", requireAuth, asyncHandler(getPresence));
router.post("/batch", requireAuth, asyncHandler(getPresenceBatch));

export default router;
