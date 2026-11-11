'use strict';
// Shared executable isolation settings; synthetic/home isolation remains the caller's responsibility.
function config(endpoint, restricted) {
  return [
    'model = "deepseek-v4-pro"', 'model_provider = "deepseek"',
    'analytics.enabled = false', 'feedback.enabled = false', 'check_for_update_on_startup = false',
    'model_reasoning_effort = "low"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
    'project_doc_max_bytes = 0', 'web_search = "disabled"',
    ...(restricted ? ['include_environment_context = false', 'include_environment_context_time = false',
      'include_permissions_instructions = false', 'include_apps_instructions = false',
      'include_collaboration_mode_instructions = false'] : []),
    '[tools.update_plan]', 'enabled = false', '[tools.experimental_request_user_input]', 'enabled = false',
    '[skills]', 'include_instructions = false', '[features]', 'shell_tool = false', 'daemon_auto_start = false',
    ...(restricted ? ['view_image', 'multi_env_copy_file', 'apps', 'plugins', 'memories', 'js_repl',
      'code_mode', 'code_mode_only', 'multi_agent', 'multi_agent_v2', 'image_generation',
      'request_permissions_tool', 'token_budget', 'current_time_reminder', 'sleep_tool', 'goals',
      'tool_suggest', 'tool_search', 'shell_snapshot'].map(key => key + ' = false') : []),
    '[model_providers.deepseek]', 'name = "Local boundary fixture"',
    'base_url = ' + JSON.stringify(endpoint + '/v1'), 'wire_api = "responses"',
    'requires_openai_auth = false', 'supports_websockets = false',
    'request_max_retries = 0', 'stream_max_retries = 0', '',
  ].join('\n');
}
module.exports = { config };
