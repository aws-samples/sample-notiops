# Savings Plans 与 RI 覆盖分析

你正在执行一次**只读**的 FinOps 承诺覆盖审查。你报告的每一个数字都必须来自工具调用——切勿估算，切勿臆造定价。请明确说明这些建议仅供参考，你不会执行任何购买操作。

## 适用场景
- 用户询问 Savings Plans（SP）、Reserved Instances（RI）、承诺覆盖率、
  利用率，或者“我能省多少钱”。
- 计算类（EC2 / Fargate / Lambda）的 on-demand 支出看起来偏高，你希望核查
  引入承诺是否有帮助。

## 步骤

1. **确立支出基线。** 使用 Cost Explorer 工具拉取最近一个完整月份的计算成本，
   按用量类型和购买方式（On-Demand、Savings Plan、Reserved）分组。记录仍以
   On-Demand 运行的占比——这就是可优化的机会。
2. **读取当前 coverage。** 拉取最近 30 天的 Savings Plans coverage 和 Reserved
   Instance coverage。记录 coverage % 以及未覆盖的 On-Demand 小时数。
3. **读取当前 utilization。** 拉取 Savings Plans utilization 和 RI utilization。
   若某项承诺*利用率不足*（低于约 95%），则说明已经在浪费——将其标记出来，
   并且在现有承诺被充分使用之前，不要建议再购买同类承诺。
4. **获取推荐方案。** 使用 Cost Explorer 的 Savings Plans 购买推荐工具
   （默认以 Compute SP、1-year、No Upfront 作为视角；如有需要也可说明 3-year）。
   记录：推荐的每小时 commitment、预估每月节省额、预估节省 %，
   以及预估回本/盈亏平衡周期。
5. **合理性核查。** 若推荐的节省额微不足道（<5%），或 coverage 已经很高
   （>85%）且 utilization 良好，请直言相告——诚实的答案可能是“你的覆盖已经
   相当到位”。

## 报告格式

产出一份简短报告，包含：

| 指标 | 数值 | 来源 |
|---|---|---|
| 上月计算支出 | $X | Cost Explorer |
| On-Demand 占比 | X% | Cost Explorer |
| 当前 SP coverage | X% | SP Coverage |
| 当前 SP utilization | X% | SP Utilization |
| 推荐 commitment | $Y/hr Compute SP, 1yr No-Upfront | SP Recommendation |
| 预估每月节省额 | $Z (~X%) | SP Recommendation |
| 预估回本周期 | N months | SP Recommendation |

随后给出：**建议**（2-3 句，通俗易懂）、**注意事项**（utilization 风险、
工作负载稳定性、期限锁定），以及**下一步**（可提出保存完整报告，并在客户
需要验证时协助其向 SP 专家开一个 Support case）。

## 护栏
- 只读。你绝不购买、修改或删除任何内容。
- 所有金额和百分比均直接引自工具输出，并注明来源。若某个工具没有返回数据，
  请说明该数据不可用，而不是猜测。
- 承诺是一项跨越数月/数年的财务决策——请将节省额表述为*估算值*，
  并建议客户在承诺前先对照自身路线图进行验证。
