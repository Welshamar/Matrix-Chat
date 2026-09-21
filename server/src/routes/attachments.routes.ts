import express, { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/asyncHandler";
import {
  MAX_CHUNK_BYTES,
  completeAttachment,
  createAttachment,
  getAttachmentMeta,
  getChunk,
  putChunk,
} from "../controllers/attachments.controller";

const router = Router();

router.post("/", requireAuth, asyncHandler(createAttachment));
router.put(
  "/:id/chunks/:index",
  requireAuth,
  express.raw({ type: "application/octet-stream", limit: MAX_CHUNK_BYTES }),
  asyncHandler(putChunk)
);
router.post("/:id/complete", requireAuth, asyncHandler(completeAttachment));
router.get("/:id", requireAuth, asyncHandler(getAttachmentMeta));
router.get("/:id/chunks/:index", requireAuth, asyncHandler(getChunk));

export default router;
