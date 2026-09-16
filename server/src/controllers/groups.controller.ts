import { Request, Response } from "express";
import { prisma } from "../db/prisma";

const MAX_GROUP_NAME_LENGTH = 60;
const MAX_MEMBERS = 50;

function serializeGroup(group: {
  id: string;
  name: string;
  avatarUrl: string | null;
  members: { userId: string; role: string; user: { username: string; avatarUrl: string | null } }[];
}) {
  return {
    groupId: group.id,
    name: group.name,
    avatarUrl: group.avatarUrl,
    members: group.members.map((m) => ({
      userId: m.userId,
      username: m.user.username,
      avatarUrl: m.user.avatarUrl,
      role: m.role,
    })),
  };
}

/** POST /api/groups — { name, memberUserIds }. Creator becomes ADMIN. */
export async function createGroup(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { name, memberUserIds } = req.body as { name?: string; memberUserIds?: string[] };

  if (!name || !name.trim() || name.length > MAX_GROUP_NAME_LENGTH) {
    res.status(400).json({ error: `Group name must be 1-${MAX_GROUP_NAME_LENGTH} characters.` });
    return;
  }
  if (!Array.isArray(memberUserIds) || memberUserIds.some((id) => typeof id !== "string")) {
    res.status(400).json({ error: "memberUserIds must be an array of user ids." });
    return;
  }

  const uniqueMemberIds = Array.from(new Set(memberUserIds.filter((id) => id !== userId)));
  if (uniqueMemberIds.length === 0) {
    res.status(400).json({ error: "A group needs at least one other member." });
    return;
  }
  if (uniqueMemberIds.length + 1 > MAX_MEMBERS) {
    res.status(400).json({ error: `Groups are capped at ${MAX_MEMBERS} members.` });
    return;
  }

  const existingUsers = await prisma.user.findMany({ where: { id: { in: uniqueMemberIds } }, select: { id: true } });
  if (existingUsers.length !== uniqueMemberIds.length) {
    res.status(400).json({ error: "One or more members are not registered Matrix Chat users." });
    return;
  }

  const group = await prisma.group.create({
    data: {
      name: name.trim(),
      createdBy: userId,
      members: {
        create: [
          { userId, role: "ADMIN" },
          ...uniqueMemberIds.map((id) => ({ userId: id, role: "MEMBER" as const })),
        ],
      },
    },
    include: { members: { include: { user: { select: { username: true, avatarUrl: true } } } } },
  });

  res.status(201).json(serializeGroup(group));
}

/** GET /api/groups — groups the caller belongs to. */
export async function listMyGroups(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;

  const groups = await prisma.group.findMany({
    where: { members: { some: { userId } } },
    include: { members: { include: { user: { select: { username: true, avatarUrl: true } } } } },
    orderBy: { createdAt: "desc" },
  });

  res.json(groups.map(serializeGroup));
}

/** GET /api/groups/:groupId — must be a member. */
export async function getGroup(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { groupId } = req.params;

  const group = await prisma.group.findFirst({
    where: { id: groupId, members: { some: { userId } } },
    include: { members: { include: { user: { select: { username: true, avatarUrl: true } } } } },
  });

  if (!group) {
    res.status(404).json({ error: "Group not found." });
    return;
  }

  res.json(serializeGroup(group));
}

async function requireAdmin(groupId: string, userId: string): Promise<boolean> {
  const membership = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } } });
  return membership?.role === "ADMIN";
}

/** POST /api/groups/:groupId/members — { userId } — ADMIN only. */
export async function addMember(req: Request, res: Response): Promise<void> {
  const requesterId = req.userId!;
  const { groupId } = req.params;
  const { userId: newUserId } = req.body as { userId?: string };

  if (!newUserId) {
    res.status(400).json({ error: "userId is required." });
    return;
  }
  if (!(await requireAdmin(groupId, requesterId))) {
    res.status(403).json({ error: "Only group admins can add members." });
    return;
  }

  const targetUser = await prisma.user.findUnique({ where: { id: newUserId } });
  if (!targetUser) {
    res.status(404).json({ error: "No user with that id." });
    return;
  }

  await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId, userId: newUserId } },
    create: { groupId, userId: newUserId, role: "MEMBER" },
    update: {},
  });

  const group = await prisma.group.findUniqueOrThrow({
    where: { id: groupId },
    include: { members: { include: { user: { select: { username: true, avatarUrl: true } } } } },
  });
  res.status(201).json(serializeGroup(group));
}

/** DELETE /api/groups/:groupId/members/:userId — self-leave, or ADMIN removing anyone. */
export async function removeMember(req: Request, res: Response): Promise<void> {
  const requesterId = req.userId!;
  const { groupId, userId: targetUserId } = req.params;

  const isSelf = requesterId === targetUserId;
  if (!isSelf && !(await requireAdmin(groupId, requesterId))) {
    res.status(403).json({ error: "Only group admins can remove other members." });
    return;
  }

  await prisma.groupMember.deleteMany({ where: { groupId, userId: targetUserId } });
  res.json({ status: "ok" });
}

/** PATCH /api/groups/:groupId/members/:userId — { role } — ADMIN only. Promotes/demotes. */
export async function updateMemberRole(req: Request, res: Response): Promise<void> {
  const requesterId = req.userId!;
  const { groupId, userId: targetUserId } = req.params;
  const { role } = req.body as { role?: string };

  if (role !== "ADMIN" && role !== "MEMBER") {
    res.status(400).json({ error: "role must be ADMIN or MEMBER." });
    return;
  }
  if (!(await requireAdmin(groupId, requesterId))) {
    res.status(403).json({ error: "Only group admins can change roles." });
    return;
  }

  await prisma.groupMember.update({
    where: { groupId_userId: { groupId, userId: targetUserId } },
    data: { role },
  });

  res.json({ status: "ok" });
}
