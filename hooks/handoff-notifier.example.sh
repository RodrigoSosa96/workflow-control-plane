#!/usr/bin/env bash
# Example workflow handoff notifier.
#
# Install by copying this file to one of the following locations and making it
# executable:
#
#   ~/.config/workflows/handoff-notifier
#   or any path referenced by $WORKFLOW_HANDOFF_NOTIFIER
#
# Environment variables set by the launcher:
#   WORKFLOW_NOTIFICATION_TYPE  handoff | stop | run
#   WORKFLOW_RUN_CONTEXT        handoff | lifecycle | stop
#   WORKFLOW_RUN_ID
#   WORKFLOW_RUN_STATE
#   WORKFLOW_RUN_STATUS
#   WORKFLOW_RUN_DIR
#   WORKFLOW_RESULT_PATH
#   WORKFLOW_RESULT_STATUS
#   WORKFLOW_RESULT_SUMMARY
#   WORKFLOW_HARNESS
#   WORKFLOW_RUN_ACTION         (only for stop notifications)

TITLE="Workflow ${WORKFLOW_RUN_ID}"
BODY="${WORKFLOW_NOTIFICATION_TYPE}: ${WORKFLOW_RUN_STATUS}"

if [ "${WORKFLOW_NOTIFICATION_TYPE}" = "stop" ] && [ -n "${WORKFLOW_RUN_ACTION}" ]; then
  BODY="${WORKFLOW_NOTIFICATION_TYPE} (${WORKFLOW_RUN_ACTION}): ${WORKFLOW_RUN_STATUS}"
fi

# Desktop notification on Linux
if command -v notify-send >/dev/null 2>&1; then
  notify-send "${TITLE}" "${BODY}"
fi

# macOS notification
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"${BODY}\" with title \"${TITLE}\""
fi

# Optional: log to a file for debugging
# echo "$(date -Iseconds) ${TITLE} ${BODY}" >> "${HOME}/.local/state/workflow-launcher/notifier.log"
