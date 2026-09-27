import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/asyncHandler";
import { fetchInbox, listConversationPeers } from "../controllers/messages.controller";

const router = Router();

router.get("/inbox", requireAuth, asyncHandler(fetchInbox));
router.get("/conversations", requireAuth, asyncHandler(listConversationPeers));

export default router;
