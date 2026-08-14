---
name: scout-planner
description: Scout then plan — interactive FIA chain
---

## scout
phase: Context
as: context
output: context.md

Analyze the codebase for {task}

## planner
phase: Planning
reads: context.md

Create an implementation plan based on {outputs.context} for {task}
