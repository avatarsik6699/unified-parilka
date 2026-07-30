import {
  MaintenanceError,
  type MaintenanceExecutionState,
  type MaintenanceFailureCode,
  type MaintenanceFailureReport,
  type MaintenancePhase,
} from "./contracts.js";

export function createExecutionState(): MaintenanceExecutionState {
  return {
    phase: "options",
    completedPhases: [],
    retentionMayBeCommitted: false,
    deferredMaintenanceMayBeCommitted: false,
  };
}

export function enterPhase(
  state: MaintenanceExecutionState,
  phase: MaintenancePhase,
): void {
  state.phase = phase;
}

export function completePhase(
  state: MaintenanceExecutionState,
): void {
  if (!state.completedPhases.includes(state.phase)) {
    state.completedPhases.push(state.phase);
  }
}

export function failureReport(
  state: MaintenanceExecutionState,
  error: unknown,
): MaintenanceFailureReport {
  const stateMayBePartiallyModified =
    state.retentionMayBeCommitted ||
    state.deferredMaintenanceMayBeCommitted;
  return {
    event: "state_maintenance_failed",
    phase: state.phase,
    completedPhases: [...state.completedPhases],
    stateMayBePartiallyModified,
    retentionMayBeCommitted: state.retentionMayBeCommitted,
    deferredMaintenanceMayBeCommitted:
      state.deferredMaintenanceMayBeCommitted,
    error: {
      code: failureCode(state.phase, error),
    },
  };
}

function failureCode(
  phase: MaintenancePhase,
  error: unknown,
): MaintenanceFailureCode {
  if (error instanceof MaintenanceError) {
    return error.code;
  }
  switch (phase) {
    case "options":
      return "invalid_options";
    case "open":
      return "database_open_failed";
    case "retention":
      return "retention_failed";
    case "deferred_fts":
      return "deferred_fts_failed";
    case "deferred_embedding_membership":
      return "deferred_embedding_failed";
    default:
      return "maintenance_failed";
  }
}
