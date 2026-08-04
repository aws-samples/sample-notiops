# WA Question → BP → Local Check Mapping

> 三层映射：AWS WA Framework Question → Best Practice → 本地 programmatic check ID。
> 让 coverage gap 显式化：哪些 BP 是程序化覆盖、哪些靠访谈/文档评估。
> 来源：AWS Well-Architected Framework + service-screener-v2 WAFS/map.json 结构启发。

---

## Coverage Legend

- ✅ **程序化覆盖** — 有对应 SEC-/REL-/COST-/OPS-/PERF-/SUS- check
- 📝 **访谈/文档评估** — 需通过 questionnaire 或 design doc review 评估
- ⚠️ **部分覆盖** — 程序化能查一部分，关键决策仍需访谈
- ❌ **未覆盖** — 当前 skill 未实现，归入未来 backlog

---

## 🔒 Security Pillar (SEC01-SEC11)

| Question | BP Title | Coverage | Local Check |
|----------|----------|----------|-------------|
| **SEC01** Securely operate workload | BP01 Separate workloads using accounts | 📝 | — |
| | BP02 Secure account root user | ✅ | SEC-06 |
| | BP03 Identify and validate control objectives | 📝 | — |
| | BP04 Stay up to date with security threats / recommendations | ⚠️ | SEC-01, SEC-02 (partial) |
| | BP05 Reduce security management scope | 📝 | — |
| | BP06 Automate testing and validation of security controls | ❌ | — |
| | BP07 Identify threats and prioritize mitigations | 📝 | — |
| | BP08 Evaluate and implement new security services | 📝 | — |
| **SEC02** Manage identities | BP01 Use strong sign-in mechanisms | ✅ | SEC-04 |
| | BP02 Use temporary credentials | ⚠️ | SEC-05 (key age proxy) |
| | BP03 Store and use secrets securely | ❌ | — |
| | BP04 Rely on centralized identity provider | 📝 | — |
| | BP05 Audit and rotate credentials periodically | ✅ | SEC-05 |
| | BP06 Leverage user groups and attributes | 📝 | — |
| **SEC03** Manage permissions | BP01 Define access requirements | 📝 | — |
| | BP02 Grant least privilege access | 📝 | — |
| | BP03 Establish emergency access process | 📝 | — |
| | BP04 Reduce permissions continuously | ❌ | — |
| | BP05 Define permission guardrails | 📝 | — |
| | BP06 Manage access based on lifecycle | 📝 | — |
| | BP07 Analyze public and cross-account access | ✅ | SEC-07 |
| | BP08 Share resources securely within organization | 📝 | — |
| | BP09 Share resources securely with third parties | 📝 | — |
| **SEC04** Detect and investigate events | BP01 Configure service and application logging | ✅ | SEC-03, SEC-11 |
| | BP02 Capture logs, findings, metrics centrally | 📝 | — |
| | BP03 Correlate and enrich security events | ❌ | — |
| | BP04 Initiate remediation for non-compliant resources | ✅ | SEC-01, SEC-02 |
| **SEC05** Protect network resources | BP01 Create network layers | 📝 | — |
| | BP02 Control traffic at all layers | ✅ | SEC-09 |
| | BP03 Implement inspection-based protection | ❌ | — |
| | BP04 Automate network protection | ❌ | — |
| **SEC06** Protect compute resources | BP01-BP06 | 📝 | — |
| **SEC07** Classify your data | BP01-BP04 | 📝 | — |
| **SEC08** Protect data at rest | BP01 Implement secure key management | ✅ | SEC-12 |
| | BP02 Enforce encryption at rest | ✅ | SEC-08, SEC-10 |
| | BP03 Automate data at rest protection | 📝 | — |
| | BP04 Enforce access control | 📝 | — |
| **SEC09** Protect data in transit | BP01-BP04 | ❌ | — (TLS check 待补) |
| **SEC10** Incident response | BP01-BP07 | 📝 | (整体靠访谈) |
| **SEC11** Application security | BP01-BP08 | 📝 | (整体靠访谈) |

**Security 覆盖率小结**：核心 11 个 ✅ check 覆盖 8 个 BP；其余靠访谈或文档评估。

---

## 🔄 Reliability Pillar (REL01-REL11)

| Question | BP Title | Coverage | Local Check |
|----------|----------|----------|-------------|
| **REL01** Manage service quotas and constraints | BP01-BP06 | ❌ | — |
| **REL02** Plan network topology | BP01-BP05 | 📝 | — |
| **REL03** Design workload service architecture | BP01-BP04 | 📝 | — |
| **REL04** Design interactions to prevent failures | BP01-BP05 | 📝 | — |
| **REL05** Design interactions for failures | BP01-BP07 | 📝 | — |
| **REL06** Monitor workload resources | BP01 Monitor all components | ⚠️ | OPS-02 (alarms proxy) |
| | BP02-BP07 | 📝 | — |
| **REL07** Adapt to demand changes | BP01 Use automation when obtaining or scaling resources | ✅ | REL-02, SUS-05 |
| | BP02 Obtain resources on detection of impairment | ✅ | REL-02, REL-03 |
| | BP03-BP04 | 📝 | — |
| **REL08** Implement change | BP01-BP05 | 📝 | — |
| **REL09** Back up data | BP01 Identify and back up all data | ✅ | REL-04 |
| | BP02 Secure and encrypt backups | ⚠️ | REL-04 (existence only) |
| | BP03 Perform data backup automatically | ✅ | REL-04 |
| | BP04 Perform periodic recovery testing | 📝 | — |
| **REL10** Use fault isolation | BP01 Deploy across multiple locations | ✅ | REL-01, REL-02, REL-06 |
| | BP02 Select appropriate locations for multi-location deployment | 📝 | — |
| | BP03 Automate recovery for components constrained to single location | 📝 | — |
| **REL11** Design for failures | BP01 Monitor all components | ✅ | REL-03 |
| | BP02 Fail over to healthy resources | ✅ | REL-05, REL-08 |
| | BP03 Use static stability | 📝 | — |
| | BP04 Rely on data plane (not control plane) | 📝 | — |
| | BP05 Send notifications when events impact availability | ⚠️ | OPS-02 |
| | BP06 Automate the recovery | ⚠️ | REL-09 |
| | BP07 Architect for fault isolation | 📝 | — |

---

## ⚙️ Operational Excellence (OPS01-OPS11)

| Question | BP Title | Coverage | Local Check |
|----------|----------|----------|-------------|
| **OPS01-03** Organization | BP01-BP* | 📝 | — |
| **OPS04** Implement observability | BP01 Identify key performance indicators | ⚠️ | OPS-02 |
| | BP02 Implement application telemetry | ❌ | — |
| | BP03 Implement infrastructure telemetry | ✅ | OPS-01, OPS-03 |
| **OPS05** Reduce defects, ease remediation, improve flow | BP01-BP* | ⚠️ | OPS-05 (CFN drift proxy) |
| **OPS06** Mitigate deployment risks | BP01-BP* | 📝 | — |
| **OPS07** Ready to support | BP01 Ensure personnel capability | 📝 | — |
| | BP02 Enable team to take action | ✅ | OPS-04 (SSM patch capability) |
| | BP03 Use runbooks | 📝 | — |
| | BP04 Use playbooks | 📝 | — |
| **OPS08** Understand workload health | BP01-BP* | ⚠️ | OPS-02 |
| **OPS09** Understand operational health | BP01-BP* | ⚠️ | OPS-08 (Health events) |
| **OPS10** Manage workload events | BP01-BP* | ⚠️ | OPS-07 (EventBridge) |
| **OPS11** Evolve operations | BP01-BP* | 📝 | (postmortem 文化访谈) |

---

## ⚡ Performance Efficiency (PERF01-PERF05)

| Question | BP Title | Coverage | Local Check |
|----------|----------|----------|-------------|
| **PERF01** Architecture selection | BP01-BP07 | 📝 | — |
| **PERF02** Compute and hardware | BP01 Select best compute options | ✅ | PERF-01, PERF-04 |
| | BP02 Understand available options | ✅ | PERF-03 |
| | BP03 Collect compute metrics | ⚠️ | PERF-03 |
| | BP04 Configure and right-size | ✅ | PERF-03 |
| | BP05 Scale compute config | ⚠️ | REL-02 |
| **PERF03** Data management | BP01 Use purpose-built data store | 📝 | — |
| | BP02 Evaluate available config options | ✅ | PERF-02, PERF-06 |
| | BP03 Collect data store metrics | ⚠️ | OPS-02 |
| | BP04 Implement strategies to improve query performance | 📝 | — |
| | BP05 Implement data access patterns | 📝 | — |
| **PERF04** Networking | BP01 Understand network impact | ⚠️ | PERF-05 (CDN) |
| | BP02-BP07 | 📝 | — |
| **PERF05** Process and culture | BP01-BP* | 📝 | — |

---

## 💰 Cost Optimization (COST01-COST11)

| Question | BP Title | Coverage | Local Check |
|----------|----------|----------|-------------|
| **COST01** Cloud financial management | BP01-BP* | 📝 | — |
| **COST02** Govern usage | BP01-BP* | 📝 | — |
| **COST03** Monitor usage and cost | BP01 Configure detailed information sources | ⚠️ | COST-01 (anomaly detection) |
| | BP02-BP* | 📝 | — |
| **COST04** Decommission resources | BP01 Track resources over their lifetime | 📝 | — |
| | BP02 Implement decommission process | ✅ | COST-03 (unattached EBS), COST-04 (unassociated EIP) |
| **COST05** Evaluate cost when selecting services | BP01-BP* | 📝 | — |
| **COST06** Meet cost targets | BP01-BP* | 📝 | — |
| **COST07** Use the most cost-effective resource | BP01 Perform pricing model analysis | ✅ | COST-06 (SP/RI) |
| | BP02 Choose Regions based on cost | 📝 | (考虑 SUS-01 region 选择) |
| | BP03 Select third-party agreements | 📝 | — |
| | BP04 Implement geographic selection | 📝 | — |
| | BP05 Right-size resources | ✅ | COST-02, COST-05 |
| **COST08** Plan for data transfer | BP01-BP* | ✅ | COST-07 (NAT data transfer) |
| **COST09** Manage demand and supply | BP01-BP* | ⚠️ | SUS-05 (auto-scaling) |
| **COST10** Evaluate new services | BP01-BP* | 📝 | — |
| **COST11** Quantify cost optimization | BP01-BP* | 📝 | — |

---

## 🌱 Sustainability (SUS01-SUS06)

| Question | BP Title | Coverage | Local Check |
|----------|----------|----------|-------------|
| **SUS01** Region selection | BP01 Choose Region based on business requirements and sustainability goals | 📝 | — |
| **SUS02** User behavior patterns | BP01-BP06 | ⚠️ | SUS-05 (scaling), SUS-02 (utilization) |
| **SUS03** Software and architecture | BP01-BP05 | ⚠️ | SUS-03 (Lambda runtime/arch) |
| **SUS04** Data | BP01-BP08 | ⚠️ | SUS-04 (Intelligent Tiering) |
| **SUS05** Hardware and services | BP01 Use minimum hardware to meet needs | ✅ | SUS-01 (Graviton), PERF-01 |
| | BP02 Use instance types with the least impact | ✅ | SUS-01 |
| | BP03 Use managed services | 📝 | — |
| | BP04 Optimize geographic placement | 📝 | — |
| | BP05 Optimize team equipment for awareness | 📝 | — |
| **SUS06** Process and culture | BP01-BP* | 📝 | — |

---

## Coverage 总结

| Pillar | Total BPs | ✅ 程序化 | ⚠️ 部分 | 📝 访谈 | ❌ 未覆盖 |
|--------|-----------|----------|---------|---------|---------|
| Security | ~50 | 8 | 4 | ~30 | ~8 |
| Reliability | ~40 | 7 | 5 | ~25 | ~3 |
| Ops Excellence | ~35 | 4 | 6 | ~25 | — |
| Performance | ~25 | 5 | 4 | ~16 | — |
| Cost | ~30 | 5 | 2 | ~22 | ~1 |
| Sustainability | ~25 | 2 | 3 | ~20 | — |
| **TOTAL** | **~205** | **31** | **24** | **~138** | **~12** |

**核心结论**：

- 程序化 check 覆盖约 *15%* 的 BP — 这是 *预期内的*，因为大多数 WA BP 涉及组织流程、文化、设计决策，无法通过 API 检测
- *使用本 skill 的正确方式*：programmatic-checks 跑完 → pillar-assessment-guide 的 4 子主题 grid 强制覆盖访谈类问题 → 最终 report 同时包含两类 finding
- 不要把"程序化 check 全 ✅"等同于"WA 评审通过"

---

## 维护说明

- 新增 check 时同步更新本表
- AWS WA Framework 更新（每年一次）后核对 BP 编号
- 参考真值源：service-screener-v2 `frameworks/WAFS/map.json` (Security only, 其他 pillar 需自查 [WA Framework 官方文档](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html))
