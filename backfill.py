"""
Backfill script — runs run_extraction on every vault note sequentially.
Results are logged to backfill-log.jsonl and a summary to backfill-summary.txt.
"""

import json
import os
import time
import urllib.request
import urllib.error
import datetime

ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")
MCP_URL = os.environ.get("MCP_URL", "https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/mcp-server")
if not ANON_KEY:
    raise SystemExit("SUPABASE_ANON_KEY env var required. Export it before running backfill.py.")

NOTE_PATHS = [
    "00-system/about-john.md",
    "00-system/claude-profile.md",
    "00-system/context-manifest.md",
    "00-system/digest-session-prompt.md",
    "00-system/frontmatter-standard.md",
    "00-system/orchestration-rules.md",
    "00-system/tech-stack.md",
    "00-system/vault-readme.md",
    "00-inbox/2026-03-31-apple-wwdc-2026-\u2014-strategic-implications-for-sigyls,-sono,-turnkey.md",
    "00-inbox/2026-03-31-claude-code-source-leak-\u2014-march-31-2026-\u2014-what-was-exposed-&-what-it-means.md",
    "00-inbox/2026-04-01-daily-digest-\u2014-richer-context-descriptions-needed.md",
    "00-inbox/2026-04-01-sono-dashboard-\u2014-greenfield-vision-(multi-business-owner-interface).md",
    "00-inbox/2026-04-02-orchestration-rule-\u2014-never-paste-secrets-into-chat.md",
    "00-inbox/2026-04-02-orchestration-rule-\u2014-secrets-must-never-appear-in-chat-in-either-direction.md",
    "00-inbox/2026-04-02-claude-code-leak-\u2014-workflow-gap-analysis-&-stack-validation.md",
    "00-inbox/2026-04-02-iconic-roofing-\u2014-field-training-session-notes-(april-2,-2026).md",
    "00-inbox/2026-04-02-iconic-roofing-\u2014-complete-field-playbook.md",
    "00-inbox/2026-04-03-automated-workshop-architecture-\u2014-tiered-decision-authority-&-haiku-courier-model.md",
    "00-inbox/2026-04-03-project-being-\u2014-philosophical-foundation-document.md",
    "00-inbox/2026-04-04-claude-code-terminal-\u2014-vs-code-prompt-boundary-fix.md",
    "00-inbox/2026-04-06-sigyls-platform-packaging-\u2014-tiered-product-concept.md",
    "00-inbox/2026-04-06-sigyls-package-naming-\u2014-the-forge-&-the-armory.md",
    "00-inbox/2026-04-07-nexus-agent-\u2014-architecture-vision-&-memory-layer-design.md",
    "00-inbox/2026-04-07-ada-\u2014-cross-session-memory-architecture.md",
    "00-inbox/2026-04-08-sanctum-\u2014-ai-optimized-second-brain-architecture-vision.md",
    "00-inbox/2026-04-09-iconic-roofing-\u2014-first-solo-field-day-notes-(april-9,-2026).md",
    "00-inbox/2026-04-09-noah-collier-\u2014-ai-training-chatbot-(sono-client-2-opportunity).md",
    "00-inbox/2026-04-09-noah-chatbot-\u2014-new-session-kickoff-context.md",
    "00-inbox/2026-04-10-claude-managed-agents-\u2014-strategic-analysis-&-sigyls-implications.md",
    "00-inbox/2026-04-10-archon-\u2014-open-source-harness-builder-analysis-&-sigyls-implications.md",
    "00-inbox/2026-04-10-foundry-pipeline-architecture-\u2014-key-decisions-from-april-10-session.md",
    "00-inbox/2026-04-10-iconic-roofing-\u2014-objection-handling-guide-(noah's-group-text).md",
    "00-inbox/2026-04-10-iconic-roofing-\u2014-field-day-notes-(april-10,-2026).md",
    "00-inbox/2026-04-10-iconic-roofing-\u2014-field-journal-(living-document).md",
    "01-projects/sigyls/2026-02-28-ai-optimized-development-building-workflows-where-machines-lead.md",
    "01-projects/sigyls/2026-02-28-anthropic-cowork-plugins-\u2014-architecture-reference-for-sono-ai.md",
    "01-projects/sigyls/2026-02-28-conversational-techniques-for-guiding-vague-ideas-into-buildable-products-ada-research.md",
    "01-projects/sigyls/2026-02-28-daily-ai-digest-\u2014-format-&-search-strategy-established.md",
    "01-projects/sigyls/2026-02-28-digest-perplexity-launches-computer-multi-model-digital-worker.md",
    "01-projects/sigyls/2026-02-28-foundry-&-workshop-frameworks-\u2014-overview-&-context-window-limits.md",
    "01-projects/sigyls/2026-02-28-sigyls-platform-research-building-ai-native-saas-companies.md",
    "01-projects/sigyls/2026-02-28-sigyls-ux-design-\u2014-ada-&-the-foundry-experience.md",
    "01-projects/sigyls/2026-02-28-sigyls-\u2014-ada-conversational-techniques-research-(ideation-facilitation).md",
    "01-projects/sigyls/2026-02-28-sigyls-\u2014-ada-visual-design-language-&-implementation-paths.md",
    "01-projects/sigyls/2026-02-28-sigyls-\u2014-ai-native-saas-business-operations-research.md",
    "01-projects/sigyls/2026-02-28-sigyls-\u2014-aria-framework-&-core-architecture-philosophy.md",
    "01-projects/sigyls/2026-03-01-ai-native-codebase-architecture--full-concept-document-v14.md",
    "01-projects/sigyls/2026-03-02-ai-native-business-architecture--domains-4-5-and-6.md",
    "01-projects/sigyls/2026-03-02-ai-native-business-architecture--domains-7-and-8.md",
    "01-projects/sigyls/2026-03-02-ai-native-business-architecture--full-concept-document-v10.md",
    "01-projects/sigyls/2026-03-02-sigyls--ada-ux-design--experience-flow.md",
    "01-projects/sigyls/2026-03-02-sigyls--ai-native-business-operations-research.md",
    "01-projects/sigyls/2026-03-02-sigyls--aria-framework--platform-architecture-origins.md",
    "01-projects/sigyls/2026-03-02-sigyls--business-strategy--competitive-positioning.md",
    "01-projects/sigyls/2026-03-02-sigyls--foundry--workshop-framework-suite-v10.md",
    "01-projects/sigyls/2026-03-02-sigyls--foundry-pipeline-blueprint--quality-gates.md",
    "01-projects/sigyls/2026-03-02-sigyls--universal-sdlc-genesis-document.md",
    "01-projects/sigyls/2026-03-03-sigyls-\u2014-hallucination-risk-analysis-across-platform-&-business-operations.md",
    "01-projects/sigyls/2026-03-03-status.md",
    "01-projects/sigyls/2026-03-04-sigyls---foundry-project-chat-notes-net-new-content.md",
    "01-projects/sigyls/2026-03-05-ai-craftsmans-workshop---project-knowledge-v10.md",
    "01-projects/sigyls/2026-03-05-deep-analysis-session---foundry-+-workshop-pipeline-review-and-methodology-additions.md",
    "01-projects/sigyls/2026-03-05-sigyls-strategic-research-addendum-v10.md",
    "01-projects/sigyls/2026-03-05-the-foundry---project-knowledge-v10.md",
    "01-projects/sigyls/2026-03-05-workshop-methodology-additions---claudemd-strategy-holdout-testing-architecture-health-check.md",
    "01-projects/sigyls/2026-03-06-claude-code-new-features--skills--http-hooks-research.md",
    "01-projects/sigyls/2026-03-06-sigyls-\u2014-workshop-build-engine---ralph-loop-as-current-best-candidate.md",
    "01-projects/sigyls/2026-03-06-workshop-enhancement-ideas-\u2014-skills-&-http-hooks-integration.md",
    "01-projects/sigyls/2026-03-08-claude-code-loop-feature-\u2014-relevance-to-sigyls-development-&-platform.md",
    "01-projects/sigyls/2026-03-09-digest-claude-marketplace-distribution-channel.md",
    "01-projects/sigyls/2026-03-09-nate-b-jones--team-size-in-the-ai-era-analysis--sigyls-relevance.md",
    "01-projects/sigyls/2026-03-09-sigyls-platform-constitution--intent-value-hierarchy--agent-governance-v10.md",
    "01-projects/sigyls/2026-03-11-ada-private-llm-advisory-\u2014-smb-to-enterprise-scaling-feature.md",
    "01-projects/sigyls/2026-03-12-living-codebase--capsule-index-architecture--greenfield-workflow.md",
    "01-projects/sigyls/2026-03-12-sigyls-business-operations-stack-registry-v10.md",
    "01-projects/sigyls/2026-03-12-sigyls-tech-stack-registry-v10.md",
    "01-projects/sigyls/2026-03-13-ai-craftsmans-workshop--project-knowledge-v11.md",
    "01-projects/sigyls/2026-03-13-sigyls--platform-terminology--stage-names.md",
    "01-projects/sigyls/2026-03-13-sigyls--project-folder-chat-history-full-summary--timeline.md",
    "01-projects/sigyls/2026-03-13-the-foundry--project-knowledge-v11.md",
    "01-projects/sigyls/2026-03-14-foundry-+-workshop-multi-agent-shared-workspace-architecture.md",
    "01-projects/sigyls/2026-03-14-workshop-v11-vs-ryan-darani-tweet--context-analysis--architecture-validation.md",
    "01-projects/sigyls/2026-03-14-workshop-v12-candidates--eye-handoff-gap-analysis.md",
    "01-projects/sigyls/2026-03-15-night-shift-+-multi-agent-workspace-architecture--chat-insights.md",
    "01-projects/sigyls/2026-03-16-sigyls-ux--nate-b-jones-principles-applied--turnkey-walkthrough.md",
    "01-projects/sigyls/2026-03-21-digest-visa-launches-agentic-ready-programme-banks-now-testing-ai-i.md",
    "01-projects/sigyls/2026-03-22-digest-google-stitch-revamps-into-ai-native-design-canvas-with-voic.md",
    "01-projects/sigyls/2026-03-22-digest-openclaws-rise-sparks-concern-that-ai-models-are-becoming-co.md",
    "01-projects/sigyls/2026-03-22-sigyls--pricing-strategy--structure-v10-authoritative.md",
    "01-projects/sigyls/2026-03-22-sigyls--target-user-reframe-marketing-message--ada-diagnostic-layer-brainstorm-v1.md",
    "01-projects/sigyls/2026-03-23-digest-mirothinker-72b-open-source-research-agent-matches-gpt-5-on-.md",
    "01-projects/sigyls/2026-03-23-digest-qwen-35-small-ships-offline-ai-on-any-iphone.md",
    "01-projects/sigyls/2026-03-24-nate-b-jones--ancient-engineering-principles--agentic-systems-video-analysis.md",
    "01-projects/sigyls/2026-03-24-sigyls--competitive-differentiation--architectural-moat-analysis.md",
    "01-projects/sigyls/2026-03-24-workshop--complete-manual-pipeline-design-v1-three-instance-architecture.md",
    "01-projects/sigyls/2026-03-24-workshop--gate-agent-architecture--story-to-story-state-handoff.md",
    "01-projects/sigyls/2026-03-25-the-sentinel--claudemd-gate-agent-directory.md",
    "01-projects/sigyls/2026-03-26-ada---concept-reel-remotion-workshop-transition.md",
    "01-projects/sigyls/2026-03-26-ada---logo-design--brand-identity-moment.md",
    "01-projects/sigyls/2026-03-26-digest-darwin-gdel-machine-now-publicly-available---self-improving-.md",
    "01-projects/sigyls/2026-03-26-digest-openai-building-super-app-combining-chatgpt-codex-and-browse.md",
    "01-projects/sigyls/the-foundry--project-knowledge-v15.md",
    "01-projects/sigyls/status.md",
    "01-projects/sigyls/sigyls-platform-glossary.md",
    "01-projects/sigyls/2026-03-14-workshop-v12-candidates--vigil-handoff-gap-analysis.md",
    "01-projects/dallas-tub-fix/2026-02-28-dtf-chat-system-\u2014-n8n-to-edge-functions-migration-complete.md",
    "01-projects/dallas-tub-fix/2026-02-28-dtf-edge-functions-\u2014-staging-environment-setup-&-unit-testing.md",
    "01-projects/dallas-tub-fix/2026-02-28-dtf-\u2014-ai-visibility-&-agent-commerce-strategy-(aeo-+-two-layer-approach).md",
    "01-projects/dallas-tub-fix/2026-03-02-dtf--ai-visibility--agent-transactable-business-strategy.md",
    "01-projects/dallas-tub-fix/2026-03-03-dtf-+-sono-ai-\u2014-edge-functions-migration-complete.md",
    "01-projects/dallas-tub-fix/2026-03-06-cipher-agent-refactor-\u2014-backend-complete.md",
    "01-projects/dallas-tub-fix/2026-03-06-cipher-agent-refactor-\u2014-production-complete.md",
    "01-projects/dallas-tub-fix/2026-03-06-cipher-agent-refactor-\u2014-testing-complete,-ready-for-production.md",
    "01-projects/dallas-tub-fix/2026-03-06-cipher-agent-test-suite-results-\u2014-5-critical-bugs-found.md",
    "01-projects/dallas-tub-fix/2026-03-06-semrush-assessment-\u2014-do-i-need-it-for-dallas-tub-fix.md",
    "01-projects/dallas-tub-fix/2026-03-11-cipher-agent-round-2-test-results-\u2014-8-new-issues-after-5-bug-fix.md",
    "01-projects/dallas-tub-fix/2026-03-15-dallas-tub-fix--sono-ai----security-overhaul--photo-architecture----march-14-2026.md",
    "01-projects/dallas-tub-fix/2026-03-21-digest-ai-powered-ad-spend-surges-63-to-57-billion-human-managed-sp.md",
    "01-projects/dallas-tub-fix/2026-03-21-digest-meta-ai-agents-now-run-ads-end-to-end-inside-ads-manager.md",
    "01-projects/dallas-tub-fix/2026-03-21-digest-only-15-of-pages-retrieved-by-chatgpt-are-cited-in-answers.md",
    "01-projects/dallas-tub-fix/2026-03-22-digest-ai-overviews-now-cut-local-search-organic-visibility-by-68.md",
    "01-projects/dallas-tub-fix/2026-03-22-digest-google-march-2026-core-update-completes-55-of-sites-saw-rank.md",
    "01-projects/dallas-tub-fix/2026-03-22-digest-meta-ai-agents-now-run-ads-end-to-end.md",
    "01-projects/dallas-tub-fix/status.md",
    "01-projects/sanctum/2026-02-28-claude-code-\u2014-visual-explainer-skill-setup.md",
    "01-projects/sanctum/2026-02-28-daily-ai-digest-\u2014-automation-approach-&-prompt-design.md",
    "01-projects/sanctum/2026-02-28-mcp-server-connected.md",
    "01-projects/sanctum/2026-02-28-obsidian-+-claude-\u2014-the-case-for-a-second-brain-(sanctum-origin).md",
    "01-projects/sanctum/2026-02-28-permanent-tunnel-live.md",
    "01-projects/sanctum/2026-02-28-sanctum-build-session-3---handoff-notes.md",
    "01-projects/sanctum/2026-02-28-sanctum-session-2---intelligence-layer-complete.md",
    "01-projects/sanctum/2026-03-01-digest-amazon-openai-stateful-runtime-environment-for-ai-agents.md",
    "01-projects/sanctum/2026-03-01-sanctum-build-\u2014-session-4-handoff.md",
    "01-projects/sanctum/2026-03-01-sanctum-system-architecture--how-everything-connects.md",
    "01-projects/sanctum/2026-03-02-sanctum-build-\u2014-session-6-handoff.md",
    "01-projects/sanctum/2026-03-03-gap-filler-\u2014-remove-manual-email-approval-flow.md",
    "01-projects/sanctum/2026-03-03-sanctum-master-build-reference--complete-state.md",
    "01-projects/sanctum/2026-03-06-paul-vault-setup--progress--architecture.md",
    "01-projects/sanctum/2026-03-08-grok-writing-vault-\u2014-vs-code-+-cline-setup.md",
    "01-projects/sanctum/2026-03-09-sanctum-vault--fixes--planned-improvements.md",
    "01-projects/sanctum/2026-03-10-paul-vault-user-guide.md",
    "01-projects/sanctum/2026-03-10-sanctum-build-session--known-limitations-and-future-fixes.md",
    "01-projects/sanctum/2026-03-15-knowledge-gap-analysis-tool----design-spec.md",
    "01-projects/sanctum/2026-03-15-slack-voice-capture-system--build-plan--decisions.md",
    "01-projects/sanctum/2026-03-16-gap-filler-diagnosis--why-orphaned-notes-arent-being-connected.md",
    "01-projects/sanctum/2026-03-16-gap-filler-diagnosis-orphaned-notes.md",
    "01-projects/sanctum/2026-03-16-vault-graph-orphan-problem--root-cause-analysis--prevention-plan.md",
    "01-projects/sanctum/2026-03-19-dell-optiplex-complete-setup-sanctum-migration-session-complete.md",
    "01-projects/sanctum/2026-03-19-march-2026-system-state--handoff--dell-migration-complete.md",
    "01-projects/sanctum/2026-03-19-mcp-server-bug-report---path-parsing-and-clean_note_structure.md",
    "01-projects/sanctum/2026-03-24-claude-code-statusline-setup.md",
    "01-projects/sanctum/2026-03-26-sanctum-infrastructure--known-risks--failure-modes.md",
    "01-projects/sanctum/2026-03-29-digest-aisi-177k-mcp-tools-65-percent-action-oriented.md",
    "01-projects/sanctum/2026-03-29-mcp-server--add-purpose-field-to-savebrainstorm-and-saveartifact-tools.md",
    "01-projects/sanctum/2026-03-29-sanctum-vault--frontmatter-standardization--claude-code-kickoff-prompt.md",
    "01-projects/sanctum/2026-03-30-dispatch-+-co-work-async-workflow--brainstorm-&-sanctum-resilience-architecture.md",
    "01-projects/sanctum/2026-03-30-phase-6--fix-needs-review-notes--claude-code-kickoff-prompt.md",
    "01-projects/sanctum/2026-03-30-sanctum-vault--index-system--00-system-folder-architecture.md",
    "01-projects/sanctum/2026-03-30-vault-index-system--phase-3-build-handoff.md",
    "01-projects/sanctum/status.md",
    "01-projects/sanctum/2026-04-08-sanctum-20--ai-optimized-second-brain--complete-architecture-spec--build-plan.md",
    "01-projects/sanctum/2026-04-08-sanctum-20-technology-roadmap--deep-research-report.md",
    "01-projects/sono/2026-03-01-sono-ai-agent-ecosystem-\u2014-supabase-edge-functions-architecture.md",
    "01-projects/sono/2026-03-02-sono-ai--n8n-to-edge-functions-migration-blueprint.md",
    "01-projects/sono/2026-03-02-sono-ai-edge-functions--migration-architecture--claudemd.md",
    "01-projects/sono/2026-03-02-sono-dashboard--ghost-theme-semantic-tokens--vercel-deployment.md",
    "01-projects/sono/2026-03-02-sono-dashboard--timezone-bug-fix--calendar-ux-improvements.md",
    "01-projects/sono/2026-03-02-stateful-vs-stateless--the-new-enterprise-ai-divide.md",
    "01-projects/sono/2026-03-03-status.md",
    "01-projects/sono/2026-03-06-claude-code-update-\u2014-claude-api-skill-+-performance-fixes-(march-5).md",
    "01-projects/sono/2026-03-06-claude-skills-\u2014-org-wide-deployment-+-open-standard-+-partner-marketplace.md",
    "01-projects/sono/2026-03-06-cowork-\u2014-scheduled-recurring-tasks-+-unified-customize-section.md",
    "01-projects/sono/2026-03-07-digest-amazon-seller-canvas-agentic-bi-dashboard.md",
    "01-projects/sono/2026-03-07-digest-gemini-flash-lite-commodity-pricing.md",
    "01-projects/sono/2026-03-08-claude-code-loop-command-+-cron-scheduling-(march-7).md",
    "01-projects/sono/2026-03-08-digest-anthropic-observed-exposure-ai-adoption-gap.md",
    "01-projects/sono/2026-03-08-digest-pro-human-ai-declaration-framework.md",
    "01-projects/sono/2026-03-15-digest-galileo-agent-control-open-source-governance.md",
    "01-projects/sono/2026-03-15-digest-linkedin-ai-citation-source.md",
    "01-projects/sono/2026-03-22-digest-goldman-sachs-survey-93-of-small-business-owners-report-posi.md",
    "01-projects/sono/2026-03-22-digest-nvidia-announces-nemoclaw-for-the-openclaw-community.md",
    "01-projects/sono/2026-03-23-digest-google-groundsource-gemini-pipeline-converts-news-into-struc.md",
    "01-projects/sono/2026-03-26-digest-enterprise-rag-hits-maturation-point-15-announcements-in-a-s.md",
    "01-projects/sono/2026-03-26-digest-mcp-hits-97-million-installs---confirmed-infrastructure-stan.md",
    "01-projects/sono/2026-03-26-sono-ai---multi-tenant-architecture-&-chat-widget-strategy.md",
    "01-projects/sono/2026-03-27-sono-ai--full-product-suite-vision-&-sigyls-ecosystem-integration.md",
    "01-projects/sono/2026-03-27-sono-widget--quick-reply-architecture-design.md",
    "01-projects/sono/2026-03-28-digest-klaviyo-composer-ai-agent-builds-full-marketing-campaigns-fr.md",
    "01-projects/sono/2026-03-28-sono--booking-mode-architecture-decision.md",
    "01-projects/sono/2026-03-28-sono--booking-mode-build--session-brief.md",
    "01-projects/sono/2026-03-28-sono-ai-\u2014-master-vision-&-orientation-document.md",
    "01-projects/sono/2026-03-28-sono-\u2014-build-vs.-integrate-decision-record.md",
    "01-projects/sono/2026-03-28-sono-\u2014-full-tool-&-configuration-map-by-business-category.md",
    "01-projects/sono/2026-03-29-cipher-agent-test-suite-v2--results--fix-brief.md",
    "01-projects/sono/2026-03-29-digest-mistral-voxtral-tts--open-weight-voice-model.md",
    "01-projects/sono/2026-03-29-sono--cipher-agent-test-suite-v2--opus-session-brief.md",
    "01-projects/sono/status.md",
    "01-projects/turnkey/2026-04-04-2026-04-03-turnkey--stage-4-patching--hardened-behavioral-spec.md",
    "01-projects/turnkey/2026-04-04-2026-04-03-turnkey--stage-5-scenario-suite--domain-b--inspection-scope-generation.md",
    "01-projects/turnkey/2026-04-04-turnkey-stage-5-scenario-suite--domain-c1--c-amd-01--tokenized-link--vendor-job-flow.md",
    "01-projects/turnkey/2026-04-04-turnkey--stage-5-scenario-suite--domain-c2--sequential-notification--rank-management.md",
    "01-projects/turnkey/2026-04-04-turnkey--stage-5-scenario-suite--domain-c3--specialized-field-worker-flows.md",
    "01-projects/turnkey/2026-04-04-turnkey-stage-5-scenario-suite--cross-cutting-multi-tenancy--failure-paths.md",
    "01-projects/turnkey/2026-04-04-2026-04-04-turnkey--stage-2-journey-map--sarah-property-manager.md",
    "01-projects/turnkey/status.md",
    "01-projects/turnkey/2026-04-04-turnkey--stage-2-journey-map--generic-vendor.md",
    "01-projects/turnkey/turnkey--stage-2-journey-map--jessica-move-in-tenant.md",
    "01-projects/turnkey/turnkey--stage-2-journey-map--david-owner-investor.md",
    "01-projects/turnkey/turnkey--stage-2-journey-map--marcus-maintenance-tech.md",
    "01-projects/turnkey/turnkey--stage-3-behavioral-spec--domain-a2--scope-generation-cost-management.md",
    "01-projects/turnkey/turnkey--stage-3-behavioral-spec--domain-b1--tokenized-link-model-vendor-notification.md",
    "01-projects/turnkey/turnkey--stage-3-behavioral-spec--domain-b2--marcus-inspection-flow.md",
    "01-projects/turnkey/2026-04-05-turnkey--stage-3-behavioral-spec--domain-b3--rosa-cleaning-jessica-move-in.md",
    "01-projects/turnkey/turnkey--stage-3-behavioral-spec--domain-c2--notification-engine.md",
    "01-projects/turnkey/turnkey--stage-4-adversarial-findings--session-1--data-integrity-multi-tenancy.md",
    "01-projects/turnkey/turnkey--stage-4-adversarial-findings--session-2--state-machine-race-conditions.md",
    "01-projects/turnkey/turnkey--stage-4-adversarial-findings--session-3--external-dependencies-failure-paths.md",
    "01-projects/turnkey/turnkey--stage-4-hardened-spec-amendments--patch-a--a1-a2-b3.md",
    "01-projects/turnkey/turnkey--stage-4-hardened-spec-amendments--patch-b--b1-b2-c1-c2.md",
    "01-projects/turnkey/turnkey--stage-4-od-schema-addendum--org-turnover-settings-and-pdf-records.md",
    "01-projects/turnkey/turnkey--stage-5-scenario-suite--domain-a2.md",
    "01-projects/turnkey/turnkey--stage-5-session-handoff--a1-s1-to-s2.md",
    "01-projects/turnkey/turnkey--stage-5-session-handoff--a2-s1-to-s2.md",
    "01-projects/turnkey/turnkey--stage-5-scenario-suite--domain-a2.md",
    "01-projects/turnkey/turnkey--stage-5-session-handoff--b1-s1-to-s2.md",
    "01-projects/turnkey/turnkey--stage-5-scenario-suite--domain-b1.md",
    "01-projects/turnkey/turnkey--stage-5-session-handoff--b2-s1-to-s2.md",
    "01-projects/turnkey/turnkey--stage-5-scenario-suite--domain-b2.md",
    "01-projects/turnkey/turnkey--stage-5-session-handoff--b3-s1-to-s2.md",
    "01-projects/turnkey/turnkey--stage-5-session-handoff--b3-s2-to-s3.md",
    "01-projects/turnkey/turnkey--stage-5-session-handoff--b3-s3-to-s4.md",
    "01-projects/turnkey/turnkey--stage-5-session-handoff--c2-s1-to-s2.md",
    "01-projects/turnkey/turnkey--stage-5-session-handoff--c1-s2-to-s3.md",
    "01-projects/turnkey/turnkey--stage-5-session-handoff--c2-s2-to-s3.md",
    "01-projects/turnkey/turnkey--stage-5-session-handoff--c2-s3-to-s4.md",
    "01-projects/turnkey/turnkey--stage-5-scenario-suite--domain-c2.md",
    "01-projects/turnkey/turnkey--spec-package--doc-01-feature-spec.md",
    "01-projects/turnkey/2026-04-08-foundry-pk-v15-proposed-additions.md",
    "01-projects/turnkey/turnkey--spec-package--doc-02-behavioral-spec--domains-c.md",
    "01-projects/turnkey/turnkey--spec-package--doc-03-security.md",
    "01-projects/turnkey/turnkey--spec-package--doc-04-monitoring.md",
    "01-projects/turnkey/turnkey--spec-package--doc-05-accessibility.md",
    "01-projects/turnkey/turnkey--spec-package--doc-07-ai-ops.md",
    "01-projects/iconic-roofing/2026-03-20-iconic-roofing---online-lead-gen-playbook.md",
    "01-projects/iconic-roofing/2026-03-20-noah-collier---conversation-summaries.md",
    "01-projects/iconic-roofing/2026-03-20-noah-collier--ride-along-notes-&-key-takeaways.md",
    "01-projects/iconic-roofing/2026-03-20-zero-budget-online-lead-generation-playbook--dfw-insurance-restoration-roofing.md",
    "01-projects/iconic-roofing/status.md",
    "03-resources/2026-03-01-claude-code-web-vs-remote-control.md",
    "03-resources/2026-03-11-claude-code-review-\u2014-multi-agent-pr-review-system-(march-9).md",
    "03-resources/2026-03-11-claude-code-v2.1.72-\u2014--plan-descriptions,--copy-file-write,-bash-parser-overhaul-(march-10).md",
    "03-resources/2026-03-11-sanctum-vault-tools--personal-reference-guide.md",
    "03-resources/2026-03-16-ai-daily-digest--master-index.md",
    "03-resources/2026-03-21-classical-learner--homeschools-connected.md",
    "03-resources/2026-03-21-founders-classical-academy.md",
    "03-resources/2026-03-21-make-electronics--ultimate-components-pack.md",
    "03-resources/2026-03-21-the-soil-creation-project.md",
    "03-resources/2026-03-22-dfw-seasonal-allergy-research---immunotherapy--real-solutions.md",
    "03-resources/2026-03-23-claude-code-new-features--project-relevance-map.md",
    "03-resources/claude-profile.md",
    "04-archive/2026-02-28-gap-analysis.md",
    "04-archive/2026-03-01-gap-analysis.md",
    "04-archive/2026-03-03-gap-analysis.md",
    "04-archive/2026-03-09-gap-analysis.md",
    "04-archive/2026-03-10-gap-analysis.md",
    "04-archive/2026-03-16-gap-analysis.md",
    "04-archive/2026-03-19-gap-analysis.md",
    "04-archive/2026-03-21-gap-analysis.md",
    "04-archive/2026-03-23-gap-analysis.md",
    "04-archive/2026-03-30-gap-analysis.md",
    "01-projects/being/2026-04-03-project-being-\u2014-philosophical-foundation-document.md",
    "01-projects/being/2026-04-04-project-being--nature-boundaries-and-the-full-life-cycle.md",
    "01-projects/turnkey/foundry/2026-04-03-turnkey--stage-4-patching--hardened-behavioral-spec.md",
    "01-projects/turnkey/foundry/2026-04-03-turnkey--stage-5-scenario-suite--domain-b--inspection-scope-generation.md",
    "01-projects/turnkey/foundry/2026-04-04-turnkey-stage-5-scenario-suite--domain-c1--c-amd-01--tokenized-link--vendor-job-flow.md",
    "01-projects/turnkey/foundry/2026-04-04-turnkey--stage-5-scenario-suite--domain-c2--sequential-notification--rank-management.md",
    "01-projects/turnkey/foundry/2026-04-04-turnkey--stage-5-scenario-suite--domain-c3--specialized-field-worker-flows.md",
    "01-projects/turnkey/foundry/2026-04-04-turnkey--stage-5-scenario-suite--cross-cutting--multi-tenancy-failure-paths.md",
    "01-projects/turnkey/foundry/2026-04-04-turnkey--stage-2-journey-map--generic-vendor.md",
    "01-projects/turnkey/foundry/turnkey--stage-2-journey-map--generic-vendor.md",
    "01-projects/turnkey/foundry/turnkey--stage-2-journey-map--rosa-cleaning-crew-lead.md",
    "01-projects/turnkey/foundry/turnkey--stage-2-journey-map--rosa-cleaning-crew-lead.md",
    "01-projects/turnkey/foundry/turnkey--stage-2-journey-map--jessica-move-in-tenant.md",
    "01-projects/turnkey/foundry/turnkey--stage-2-journey-map--david-owner-investor.md",
    "01-projects/turnkey/foundry/turnkey--stage-2-journey-map--marcus-maintenance-tech.md",
    "01-projects/turnkey/foundry/turnkey--stage-3-behavioral-spec--domain-a2--scope-generation-cost-management.md",
    "01-projects/turnkey/foundry/turnkey--stage-3-behavioral-spec--domain-b2--marcus-inspection-flow.md",
    "01-projects/turnkey/foundry/turnkey--stage-3-behavioral-spec--domain-b3--rosa-cleaning-jessica-move-in.md",
    "01-projects/turnkey/foundry/turnkey--stage-3-behavioral-spec--domain-c2--notification-engine.md",
    "01-projects/turnkey/foundry/turnkey--stage-3-behavioral-spec--domain-a1--turnover-creation-board-management.md",
    "01-projects/turnkey/foundry/turnkey--stage-3-behavioral-spec--domain-b1--tokenized-link-model-vendor-notification.md",
    "01-projects/turnkey/foundry/turnkey--stage-3-behavioral-spec--domain-c1--david-owner-portal.md",
    "01-projects/turnkey/foundry/turnkey--stage-4-adversarial-findings--session-1--data-integrity-multi-tenancy.md",
    "01-projects/turnkey/foundry/turnkey--stage-4-adversarial-findings--session-2--state-machine-race-conditions.md",
    "01-projects/turnkey/foundry/turnkey--stage-4-adversarial-findings--session-3--external-dependencies-failure-paths.md",
    "01-projects/turnkey/foundry/turnkey--stage-4-hardened-spec-amendments--patch-a--a1-a2-b3.md",
    "01-projects/turnkey/foundry/turnkey--stage-4-hardened-spec-amendments--patch-b--b1-b2-c1-c2.md",
    "01-projects/turnkey/foundry/turnkey--stage-4-od-schema-addendum--org-turnover-settings-and-pdf-records.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-session-handoff--a1-s1-to-s2.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-session-handoff--a2-s1-to-s2.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-scenario-suite--domain-a2.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-session-handoff--b1-s1-to-s2.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-scenario-suite--domain-b1.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-session-handoff--b2-s1-to-s2.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-scenario-suite--domain-b2.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-session-handoff--b3-s1-to-s2.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-session-handoff--b3-s2-to-s3.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-session-handoff--b3-s3-to-s4.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-session-handoff--c2-s1-to-s2.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-session-handoff--c1-s2-to-s3.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-session-handoff--c2-s2-to-s3.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-session-handoff--c2-s3-to-s4.md",
    "01-projects/turnkey/foundry/turnkey--stage-5-scenario-suite--domain-c2.md",
    "01-projects/turnkey/spec-package/2026-04-04-turnkey--stage-5-scenario-suite--cross-cutting--multi-tenancy-failure-paths.md",
    "01-projects/turnkey/spec-package/2026-04-03-turnkey--stage-6-spec-assembly--doc-1--feature-spec.md",
    "01-projects/turnkey/spec-package/turnkey--spec-package--doc-01-feature-spec.md",
    "01-projects/turnkey/spec-package/turnkey--spec-package--doc-02-behavioral-spec--domains-c.md",
    "01-projects/turnkey/spec-package/turnkey--spec-package--doc-03-security.md",
    "01-projects/turnkey/spec-package/turnkey--spec-package--doc-04-monitoring.md",
    "01-projects/turnkey/spec-package/turnkey--spec-package--doc-05-accessibility.md",
    "01-projects/turnkey/spec-package/turnkey--spec-package--doc-07-ai-ops.md",
    "01-projects/turnkey/notes/2026-04-08-foundry-pk-v15-proposed-additions.md",
]

LOG_FILE    = r"C:/Users/John Figs/sanctum-functions/backfill-log.jsonl"
SUMMARY_FILE = r"C:/Users/John Figs/sanctum-functions/backfill-summary.txt"

def call_run_extraction(note_path: str) -> dict:
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "run_extraction",
            "arguments": {"note_path": note_path}
        }
    }).encode("utf-8")

    req = urllib.request.Request(
        MCP_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {ANON_KEY}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = resp.read().decode("utf-8")
        # Parse SSE: find data: line
        for line in raw.splitlines():
            if line.startswith("data: "):
                data = json.loads(line[6:])
                text = data.get("result", {}).get("content", [{}])[0].get("text", "")
                return {"ok": True, "text": text}
        return {"ok": False, "text": "no data line in response"}
    except Exception as e:
        return {"ok": False, "text": str(e)}


def parse_result_text(text: str) -> dict:
    """Extract entities, decisions, note_id from the result text."""
    import re
    entities = decisions = note_id = None
    m = re.search(r"Entities:\s*(\d+)", text)
    if m: entities = int(m.group(1))
    m = re.search(r"Decisions:\s*(\d+)", text)
    if m: decisions = int(m.group(1))
    m = re.search(r"Note ID:\s*([0-9a-f-]{36})", text)
    if m: note_id = m.group(1)
    return {"entities": entities, "decisions": decisions, "note_id": note_id}


def main():
    total       = len(NOTE_PATHS)
    succeeded   = 0
    failed      = 0
    not_found   = 0
    total_entities   = 0
    total_decisions  = 0
    errors      = []

    start_time = time.time()

    with open(LOG_FILE, "w", encoding="utf-8") as log:
        for i, path in enumerate(NOTE_PATHS, 1):
            t0 = time.time()
            result = call_run_extraction(path)
            elapsed = round(time.time() - t0, 1)

            text = result["text"]
            parsed = parse_result_text(text) if result["ok"] else {}

            is_not_found = "Note not found" in text
            is_error     = not result["ok"] or ("Pipeline failed" in text) or ("❌" in text and not is_not_found)
            is_success   = result["ok"] and "✅" in text

            if is_success:
                succeeded += 1
                total_entities  += parsed.get("entities") or 0
                total_decisions += parsed.get("decisions") or 0
                status = "OK"
            elif is_not_found:
                not_found += 1
                status = "NOT_FOUND"
            else:
                failed += 1
                errors.append(path)
                status = "ERROR"

            entry = {
                "n":          i,
                "path":       path,
                "status":     status,
                "entities":   parsed.get("entities"),
                "decisions":  parsed.get("decisions"),
                "note_id":    parsed.get("note_id"),
                "elapsed_s":  elapsed,
                "message":    text[:200],
            }
            log.write(json.dumps(entry) + "\n")
            log.flush()

            tag = "[OK]   " if is_success else ("[MISS] " if is_not_found else "[ERR]  ")
            e_str = str(parsed.get("entities", "-")).rjust(3)
            d_str = str(parsed.get("decisions", "-")).rjust(3)
            print(f"[{i:>3}/{total}] {tag} E:{e_str} D:{d_str} {elapsed:>5}s  {path}")

    total_elapsed = round(time.time() - start_time)

    summary = f"""Backfill complete — {datetime.datetime.now().isoformat()}

Notes processed : {total}
  Succeeded     : {succeeded}
  Not found     : {not_found}
  Errors        : {failed}

Entities extracted  : {total_entities}
Decisions extracted : {total_decisions}
Total time          : {total_elapsed}s ({round(total_elapsed/60, 1)} min)

Failed paths:
{"  (none)" if not errors else chr(10).join(f"  {p}" for p in errors)}
"""
    with open(SUMMARY_FILE, "w", encoding="utf-8") as f:
        f.write(summary)

    print("\n" + summary)


if __name__ == "__main__":
    main()
