import { useEffect, useState } from 'react';
import { FEATURES, PLANS, priceFor, type Billing } from './data';
import { FeatureMatrix, PlanCard } from './FeatureMatrix';

export default function PricingPage() {
  const [billing, setBilling] = useState<Billing>('monthly');
  const [discount, setDiscount] = useState(0);
  useEffect(() => {
    setDiscount(billing === 'yearly' ? 0.2 : 0);
  }, [billing]);

  return (
    <main>
      <button
        aria-label="Toggle yearly billing"
        onClick={() => setBilling((b) => (b === 'monthly' ? 'yearly' : 'monthly'))}
      >
        {billing === 'monthly' ? 'Monthly' : 'Yearly (save 20 %)'}
      </button>
      {PLANS.map((plan) => (
        <PlanCard key={plan.id} name={plan.name} price={priceFor(plan.monthly, billing, discount)} />
      ))}
      <FeatureMatrix
        features={FEATURES}
        plans={PLANS}
        labels={{ included: 'Included', missing: 'Not included' }}
      />
    </main>
  );
}
