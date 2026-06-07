import { Router, type IRouter } from "express";
import healthRouter from "./health";
import translateRouter from "./translate/index";

const router: IRouter = Router();

router.use(healthRouter);
router.use(translateRouter);

export default router;
