/** Host-owned restrictions for model-only Core sessions. These never come from
 * the model or change the user's on-disk Codex/Worker configuration. */
export function coreToolConfig(mcpServers:Record<string,unknown>):Record<string,unknown>{
 const disabled=[
  'shell_tool','shell_snapshot','unified_exec','apply_patch_freeform',
  'apps','connectors','plugins','remote_plugin','hooks','codex_hooks',
  'browser_use','browser_use_external','in_app_browser','computer_use',
  'multi_agent','multi_agent_v2','multi_agent_mode','enable_fanout','collab','agent_message_board','send_async_message','send_message_to_user_async',
  'js_repl','js_repl_tools_only','code_mode','code_mode_host','code_mode_only','code_mode_only_strict_3p_tools','code_mode_tool_search',
  'view_image','search_tool','standalone_web_search','tool_search','image_generation','imagegenext',
  'request_permissions','request_permissions_tool','skill_mcp_dependency_install','skill_search','tool_suggest','stable_environment_tools',
  'memories','memory_tool','goals','sleep_tool','default_mode_request_user_input',
  'token_budget','current_time_reminder','deferred_executor',
 ];
 return{
  ...Object.fromEntries(disabled.map(name=>['features.'+name,false])),
  'features.skip_host_skill_discovery':true,'skills.include_instructions':false,project_doc_max_bytes:0,web_search:'disabled',notify:[],
  'tools.experimental_request_user_input.enabled':false,'tools.update_plan.enabled':false,
  // Empty tables merge with inherited configuration. Disable each discovered
  // server explicitly, including required servers, before thread startup.
  // Use a nested table: App Server's dotted override splitter does not support
  // quoted segments, so dotted MCP names must remain literal object keys.
  mcp_servers:Object.fromEntries(Object.keys(mcpServers).map(name=>[name,{enabled:false,required:false}])),
 };
}
