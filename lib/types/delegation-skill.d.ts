/**
 * The plugin's delegation skill: the task-brief template and pre-dispatch checks
 * from the author's own skill, merged with the operational facts of this plugin
 * (tool parameters, background jobs, panel, timeouts) and with the official
 * `subagent_claude_code` path so one skill answers "how do I delegate here".
 *
 * Registered at runtime with the plugin, so installing the plugin installs it —
 * there is no second copy under the user's skills directory to drift out of sync.
 */
import type { SkillRegistration } from '@deepseek-ai/dsh-skill';
export declare const DELEGATION_SKILL: SkillRegistration;
