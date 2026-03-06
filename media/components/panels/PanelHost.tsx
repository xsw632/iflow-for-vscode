import {
  pendingConfirmation,
  pendingQuestion,
  pendingPlanApproval,
} from "../../store/signals";
import { ApprovalPanel } from "./ApprovalPanel";
import { QuestionPanel } from "./QuestionPanel";
import { PlanApprovalPanel } from "./PlanApprovalPanel";

/**
 * Routes to the currently active modal panel.
 * Panels are mutually exclusive — only one can be active at a time.
 */
export function PanelHost() {
  const conf = pendingConfirmation.value;
  if (conf) return <ApprovalPanel conf={conf} />;

  const question = pendingQuestion.value;
  if (question) return <QuestionPanel pq={question} />;

  const plan = pendingPlanApproval.value;
  if (plan) return <PlanApprovalPanel pp={plan} />;

  return null;
}
