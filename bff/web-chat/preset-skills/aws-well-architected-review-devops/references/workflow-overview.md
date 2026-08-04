# Workflow Overview

## 4-Phase Automated Assessment Flow

```mermaid
flowchart TD
    A[User: Start WA Review] --> B{Phase 1: Bootstrap}
    B -->|Credentials Valid| C[Phase 2: Discover]
    B -->|Invalid/Write Perms| X[HALT — Fix Credentials]
    
    C --> C1[1. Security ★]
    C1 --> C2[2. Ops Excellence]
    C2 --> C3[3. Reliability]
    C3 --> C4[4. Performance]
    C4 --> C5[5. Cost Optimization]
    C5 --> C6[6. Sustainability]
    
    C6 --> D[Phase 3: Analysis]
    D --> D1[Risk Consolidation]
    D1 --> D2[HRI/MRI Classification]
    D2 --> D3[Priority Matrix]
    D3 --> D4[Improvement Roadmap]
    
    D4 --> E[Phase 4: Report]
    E --> E1[Markdown Report]
    E --> E2[HTML Report]
    E --> E3[Executive Summary]
    
    E1 --> F{Sync to WA Tool?}
    F -->|Yes| G[WA Tool API Sync]
    F -->|No| H[Done ✅]
    G --> H
```

## Phase Details

### Phase 1: Bootstrap (~2 minutes)
- **Human interaction**: YES (credential confirmation + scope selection)
- **Inputs**: AWS credentials, target account/region
- **Outputs**: Validated environment config
- **Can fail**: Yes — invalid credentials or write permissions detected

### Phase 2: Discover (~15-30 minutes)
- **Human interaction**: NO (fully automated)
- **Inputs**: Environment config from Phase 1
- **Outputs**: Per-pillar findings with severity ratings
- **Order**: Security ALWAYS first (Security-First principle)
- **Parallelism**: Sequential (one pillar at a time to manage API rate limits)

### Phase 3: Analysis (~5 minutes)
- **Human interaction**: NO
- **Inputs**: All pillar findings
- **Outputs**: Risk portfolio, priority matrix, improvement roadmap

### Phase 4: Report (~2 minutes)
- **Human interaction**: NO (optional WA Tool sync prompt)
- **Inputs**: Analysis results
- **Outputs**: Markdown report, HTML report, executive summary

## Security-First Principle

Security is ALWAYS assessed first because:
1. Security vulnerabilities can invalidate all other improvements
2. Security services (GuardDuty, CloudTrail) provide visibility for other pillars
3. Compliance requirements often mandate security baselines
4. Security incidents are exponentially more expensive than prevention

## Error Handling

| Error | Action |
|-------|--------|
| API throttling (429) | Exponential backoff (AWS CLI handles this) |
| Permission denied | Log as UNABLE_TO_ASSESS, not a finding |
| Service unavailable | Skip with region note |
| Timeout | Retry once, then skip |
| Credential expired | Prompt re-authentication |

## Assessment Depth

| Scope | Pillars | Estimated Time | Checks |
|-------|---------|----------------|--------|
| Quick Scan | Security only | ~5 min | ~25 |
| Focused | Security + 1-2 pillars | ~10-15 min | ~50-75 |
| Standard | All 6 pillars | ~20-30 min | ~150 |
| Deep Dive | All 6 + cross-pillar | ~30-45 min | ~200+ |
