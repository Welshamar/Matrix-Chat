import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/asyncHandler";
import {
  addMember,
  createGroup,
  getGroup,
  listMyGroups,
  removeMember,
  updateMemberRole,
} from "../controllers/groups.controller";

const router = Router();

router.post("/", requireAuth, asyncHandler(createGroup));
router.get("/", requireAuth, asyncHandler(listMyGroups));
router.get("/:groupId", requireAuth, asyncHandler(getGroup));
router.post("/:groupId/members", requireAuth, asyncHandler(addMember));
router.delete("/:groupId/members/:userId", requireAuth, asyncHandler(removeMember));
router.patch("/:groupId/members/:userId", requireAuth, asyncHandler(updateMemberRole));

export default router;
