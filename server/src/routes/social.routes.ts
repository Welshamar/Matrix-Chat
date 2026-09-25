import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/asyncHandler";
import {
  blockUser,
  getBlocks,
  getMutes,
  muteThread,
  reportUser,
  unblockUser,
  unmuteThread,
} from "../controllers/social.controller";

const router = Router();

router.post("/block", requireAuth, asyncHandler(blockUser));
router.post("/unblock", requireAuth, asyncHandler(unblockUser));
router.get("/blocks", requireAuth, asyncHandler(getBlocks));
router.post("/report", requireAuth, asyncHandler(reportUser));
router.post("/mute", requireAuth, asyncHandler(muteThread));
router.post("/unmute", requireAuth, asyncHandler(unmuteThread));
router.get("/mutes", requireAuth, asyncHandler(getMutes));

export default router;
