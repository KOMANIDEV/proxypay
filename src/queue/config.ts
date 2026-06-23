import { QueueOptions } from "bullmq";
import { redisClient } from "../config/redis";

export const connection = {};
export const queueOptions: QueueOptions = {
  connection: {},
};
