/**
 * Presets: ready-made employees for the hire form. A preset names a role sentence, the tools
 * that role needs and a model tier; the model itself comes from the company's setting for that
 * tier, so a company can put its engineers on a different model without touching the presets.
 */
import type { Capability, ModelTier } from '../shared/types.ts';

export type Preset = { label: string; role: string; capabilities: Capability[]; skills: string[]; tier: ModelTier; lead: boolean };
export type PresetId = 'chief_of_staff' | 'engineering_lead' | 'engineer' | 'reviewer' | 'marketing_writer' | 'analyst';

export const PRESETS: Record<PresetId, Preset> = {
  chief_of_staff: {
    label: 'Chief of staff',
    role: 'Turns what the user says in the company chat into tasks on the right teams, answers questions about where things stand, and never does the work itself.',
    capabilities: ['read_files'],
    skills: [],
    tier: 'lead',
    lead: true,
  },
  engineering_lead: {
    label: 'Engineering lead',
    role: 'Splits a task into sub-tasks with clear file ownership and done-conditions, reviews what comes back against the brief, and integrates the pieces.',
    capabilities: ['read_files', 'run_commands', 'write_code'],
    skills: [],
    tier: 'lead',
    lead: true,
  },
  engineer: {
    label: 'Engineer',
    role: 'Builds what the brief asks for inside the files the task owns, runs the gates before reporting, and says plainly what was and was not done.',
    capabilities: ['read_files', 'run_commands', 'write_code'],
    skills: [],
    tier: 'member',
    lead: false,
  },
  reviewer: {
    label: 'Reviewer',
    role: 'Reads finished work against its brief and done-condition, runs the gates again, and approves it or sends it back with notes the author can act on. Never edits.',
    capabilities: ['read_files', 'run_commands'],
    skills: [],
    tier: 'lead',
    lead: false,
  },
  marketing_writer: {
    label: 'Marketing writer',
    role: 'Writes product copy, store descriptions and announcements in plain language from what the product really does, and drafts only: publishing is a decision for the user.',
    capabilities: ['read_files', 'write_code', 'web_search'],
    skills: [],
    tier: 'member',
    lead: false,
  },
  analyst: {
    label: 'Analyst',
    role: 'Reads logs and data, finds the patterns that matter, and writes a short note with what to change and the evidence for it. Invents no numbers.',
    capabilities: ['read_files', 'run_commands', 'web_search'],
    skills: ['dataviz'],
    tier: 'member',
    lead: false,
  },
};
