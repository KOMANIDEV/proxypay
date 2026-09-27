import logger from "../utils/logger";

export type IncidentSeverity = "SEV1_CRITICAL" | "SEV2_MAJOR" | "SEV3_MODERATE" | "SEV4_MINOR";
export type PostMortemStatus = "DRAFT" | "IN_REVIEW" | "PUBLISHED" | "ARCHIVED";

export interface ActionItem {
  id: string;
  description: string;
  assignee: string;
  dueDate: Date;
  status: "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  completedAt?: Date;
}

export interface IncidentPostMortem {
  id: string;
  incidentTitle: string;
  severity: IncidentSeverity;
  startedAt: Date;
  detectedAt: Date;
  resolvedAt: Date;
  impactSummary: string;
  rootCauseAnalysis: {
    primaryCause: string;
    contributingFactors: string[];
    fiveWhys: string[];
    technicalDetails: string;
  };
  timeline: Array<{ timestamp: Date; description: string; author: string }>;
  actionItems: ActionItem[];
  status: PostMortemStatus;
  publishedAt?: Date;
  archivedAt?: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export class IncidentPostMortemService {
  private postMortems: Map<string, IncidentPostMortem> = new Map();

  /**
   * Create a new post-mortem record in DRAFT status.
   */
  public createPostMortem(data: Omit<IncidentPostMortem, "id" | "status" | "actionItems" | "createdAt" | "updatedAt">): IncidentPostMortem {
    const id = `pm-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date();

    const postMortem: IncidentPostMortem = {
      ...data,
      id,
      actionItems: [],
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
    };

    this.postMortems.set(id, postMortem);
    logger.info(`[PostMortem] Created post-mortem ${id} for incident "${data.incidentTitle}"`);
    return postMortem;
  }

  /**
   * Add action items to mitigate future recurrences.
   */
  public addActionItem(postMortemId: string, item: Omit<ActionItem, "id" | "status">): ActionItem {
    const pm = this.postMortems.get(postMortemId);
    if (!pm) throw new Error(`Post-mortem ${postMortemId} not found`);

    const actionItem: ActionItem = {
      ...item,
      id: `act-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      status: "OPEN",
    };

    pm.actionItems.push(actionItem);
    pm.updatedAt = new Date();
    return actionItem;
  }

  /**
   * Complete an action item.
   */
  public completeActionItem(postMortemId: string, actionItemId: string): ActionItem {
    const pm = this.postMortems.get(postMortemId);
    if (!pm) throw new Error(`Post-mortem ${postMortemId} not found`);

    const item = pm.actionItems.find((a) => a.id === actionItemId);
    if (!item) throw new Error(`Action item ${actionItemId} not found`);

    item.status = "COMPLETED";
    item.completedAt = new Date();
    pm.updatedAt = new Date();
    return item;
  }

  /**
   * Publish post-mortem for internal sharing.
   */
  public publishPostMortem(postMortemId: string): IncidentPostMortem {
    const pm = this.postMortems.get(postMortemId);
    if (!pm) throw new Error(`Post-mortem ${postMortemId} not found`);

    pm.status = "PUBLISHED";
    pm.publishedAt = new Date();
    pm.updatedAt = new Date();
    logger.info(`[PostMortem] Published post-mortem ${postMortemId}`);
    return pm;
  }

  /**
   * Archive post-mortem.
   */
  public archivePostMortem(postMortemId: string): IncidentPostMortem {
    const pm = this.postMortems.get(postMortemId);
    if (!pm) throw new Error(`Post-mortem ${postMortemId} not found`);

    pm.status = "ARCHIVED";
    pm.archivedAt = new Date();
    pm.updatedAt = new Date();
    logger.info(`[PostMortem] Archived post-mortem ${postMortemId}`);
    return pm;
  }

  public getPostMortem(id: string): IncidentPostMortem | undefined {
    return this.postMortems.get(id);
  }

  public listPostMortems(status?: PostMortemStatus): IncidentPostMortem[] {
    const all = Array.from(this.postMortems.values());
    if (status) return all.filter((p) => p.status === status);
    return all;
  }
}

export const incidentPostMortemService = new IncidentPostMortemService();
