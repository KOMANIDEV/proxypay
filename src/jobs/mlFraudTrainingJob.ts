/**
 * #485 – ML fraud detection training job
 *
 * Retrains the fraud classifier on the accumulated training set (seeded by the
 * rule engine and by analyst feedback) and promotes the new artefact only when
 * it is at least as good as the model currently serving traffic.
 *
 * A model that regresses is left inactive so the previous artefact keeps
 * handling requests – a bad training run must never degrade live scoring.
 */

import {
  mlFraudDetectionService,
  MlFraudModel,
} from "../services/mlFraudDetectionService";
import { notifySlackAlert } from "../services/loggers";

/** Minimum F1 a candidate model must reach before it can be promoted. */
const MIN_F1 = Number(process.env.ML_FRAUD_MIN_F1 ?? 0.6);
/** Do not retrain more often than this many hours. */
const MIN_TRAIN_INTERVAL_HOURS = 12;

export async function runMlFraudTrainingJob(): Promise<void> {
  console.info("[ml-fraud-training] Starting model training job");

  const active = await mlFraudDetectionService.getActiveModel();
  if (active && !isDueForRetraining(active)) {
    console.info(
      `[ml-fraud-training] Skipping – model ${active.modelVersion} was trained less than ${MIN_TRAIN_INTERVAL_HOURS}h ago`,
    );
    return;
  }

  const candidate = await mlFraudDetectionService.trainAndPromote();
  if (!candidate) {
    console.info(
      "[ml-fraud-training] Not enough labelled data – no model trained",
    );
    return;
  }

  if (active && (candidate.f1 ?? 0) < (active.f1 ?? 0)) {
    console.warn(
      `[ml-fraud-training] Candidate ${candidate.modelVersion} regressed ` +
        `(f1 ${(candidate.f1 ?? 0).toFixed(3)} < ${(active.f1 ?? 0).toFixed(3)}) – rolling back to ${active.modelVersion}`,
    );
    await mlFraudDetectionService.activateModel(active.modelVersion);
    return;
  }

  if ((candidate.f1 ?? 0) < MIN_F1) {
    console.warn(
      `[ml-fraud-training] Candidate f1 ${(candidate.f1 ?? 0).toFixed(3)} is below the ${MIN_F1} floor – keeping ${active?.modelVersion ?? "no model"}`,
    );
    if (active) {
      await mlFraudDetectionService.activateModel(active.modelVersion);
    } else {
      await mlFraudDetectionService.activateModel(candidate.modelVersion);
    }
    return;
  }

  console.info(
    `[ml-fraud-training] Promoted ${candidate.modelVersion}: ` +
      `accuracy=${(candidate.accuracy ?? 0).toFixed(3)} ` +
      `precision=${(candidate.precision ?? 0).toFixed(3)} ` +
      `recall=${(candidate.recall ?? 0).toFixed(3)} ` +
      `f1=${(candidate.f1 ?? 0).toFixed(3)} ` +
      `samples=${candidate.trainingSize}`,
  );

  await notifySlackAlert(
    {
      statusCode: 200,
      method: "MONITOR",
      path: `/ml-fraud/model/${candidate.modelVersion}`,
      timestamp: new Date().toISOString(),
      error: new Error(
        `Promoted fraud model ${candidate.modelVersion} trained on ${candidate.trainingSize} samples ` +
          `(accuracy ${(candidate.accuracy ?? 0).toFixed(3)}, f1 ${(candidate.f1 ?? 0).toFixed(3)}).`,
      ),
    },
    { appName: "ml-fraud-training" },
  );
}

function isDueForRetraining(model: MlFraudModel): boolean {
  return (
    Date.now() - model.trainedAt.getTime() >=
    MIN_TRAIN_INTERVAL_HOURS * 60 * 60 * 1000
  );
}
