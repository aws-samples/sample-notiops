# Credential Permission Boundary

## Principle

The WA Review assessment operates in **strict read-only mode**. Credentials MUST NOT have any write, modify, or delete permissions.

## Allowed IAM Policies

| Policy ARN | Description |
|-----------|-------------|
| `arn:aws:iam::aws:policy/ReadOnlyAccess` | Full read-only across all services |
| `arn:aws:iam::aws:policy/ViewOnlyAccess` | View-only (slightly more restrictive) |
| `arn:aws:iam::aws:policy/SecurityAudit` | Security-focused read-only |
| Custom read-only policy | Must contain ONLY Describe/Get/List actions |

## Blocked IAM Policies

| Policy ARN | Reason |
|-----------|--------|
| `arn:aws:iam::aws:policy/AdministratorAccess` | Full admin — NEVER acceptable |
| `arn:aws:iam::aws:policy/PowerUserAccess` | Write access to most services |
| Any `*:Create*`, `*:Update*`, `*:Delete*`, `*:Put*` | Write actions |

## Validation Logic

```python
ALLOWED_PREFIXES = {'Describe', 'Get', 'List', 'BatchGet'}
BLOCKED_PREFIXES = {'Create', 'Update', 'Delete', 'Put', 'Modify',
                    'Start', 'Stop', 'Terminate', 'Reboot', 'Run',
                    'Invoke', 'Execute', 'Send', 'Publish', 'Tag',
                    'Untag', 'Attach', 'Detach', 'Associate', 'Disassociate'}

def is_read_only(actions: list) -> bool:
    for action in actions:
        verb = action.split(':')[1] if ':' in action else action
        if verb == '*':
            return False
        if any(verb.startswith(p) for p in BLOCKED_PREFIXES):
            return False
    return True
```

## Violation Warning

If credentials fail validation, display:

```
🚨 PERMISSION BOUNDARY VIOLATION

Your credentials ({arn}) have write permissions that exceed
the read-only boundary required for this assessment.

Detected policies: {policy_list}

The assessment CANNOT proceed with these credentials because:
• Write permissions could accidentally modify your infrastructure
• This assessment is designed to be 100% non-destructive
• Read-only ensures zero risk to your production environment

ACTION REQUIRED:
1. Create a new IAM role with ReadOnlyAccess policy
2. Assume that role or configure new credentials
3. Re-run the assessment

Example:
  aws iam create-role --role-name WAReviewReadOnly \
    --assume-role-policy-document file://trust-policy.json
  aws iam attach-role-policy --role-name WAReviewReadOnly \
    --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
```

## Exceptions

The following write-like actions are ALLOWED (metadata only, no infrastructure changes):
- `sts:GetCallerIdentity` — identity verification
- `sts:GetSessionToken` — session management
- `iam:GenerateCredentialReport` — generates a report, does not modify IAM
