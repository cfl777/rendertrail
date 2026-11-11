import { memo } from 'react';
import type { Feature, Labels, Plan } from './data';

// Deliberately slow (about 0.1 ms per row) so wasted renders cost real time.
function busyWait(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // do nothing
  }
}

function FeatureRow({ feature, plans, labels }: { feature: Feature; plans: Plan[]; labels: Labels }) {
  busyWait(0.1);
  return (
    <tr>
      <th>{feature.name}</th>
      {plans.map((plan) => (
        <td key={plan.id}>{feature.plans.includes(plan.id) ? labels.included : labels.missing}</td>
      ))}
    </tr>
  );
}

type FeatureMatrixProps = { features: Feature[]; plans: Plan[]; labels: Labels };

export const FeatureMatrix = memo(function FeatureMatrix({ features, plans, labels }: FeatureMatrixProps) {
  return (
    <table>
      <tbody>
        {features.map((feature) => (
          <FeatureRow key={feature.id} feature={feature} plans={plans} labels={labels} />
        ))}
      </tbody>
    </table>
  );
});

export const PlanCard = memo(function PlanCard({ name, price }: { name: string; price: number }) {
  return (
    <article>
      <h2>{name}</h2>
      <p>{price} EUR</p>
    </article>
  );
});
