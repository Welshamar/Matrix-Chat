import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { fetchInbox } from "../controllers/messages.controller";

const router = Router();

router.get("/inbox", requireAuth, fetchInbox);

export default router;
