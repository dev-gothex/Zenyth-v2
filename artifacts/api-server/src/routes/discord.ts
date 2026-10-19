import { Router, type IRouter } from "express";
import {
  getZenythBotStatus,
  getZenythCommandModules,
} from "../kyzen/bot";
import { ZENYTH_COMMAND_COUNT, ZENYTH_MODULES } from "../kyzen/modules";
import {
  MODERATION_COMMAND_COUNT,
  UNCATEGORIZED_COMMAND_COUNT,
} from "../kyzen/catalog";

const router: IRouter = Router();

router.get("/discord/status", (_req, res) => {
  res.json(getZenythBotStatus());
});

router.get("/discord/modules", (_req, res) => {
  res.json({
    declaredModuleCount: ZENYTH_MODULES.length,
    cataloguedCommandCount: ZENYTH_COMMAND_COUNT,
    moderationMappedCount: MODERATION_COMMAND_COUNT,
    categoryUnavailableCount: UNCATEGORIZED_COMMAND_COUNT,
    modules: getZenythCommandModules(),
  });
});

export default router;
