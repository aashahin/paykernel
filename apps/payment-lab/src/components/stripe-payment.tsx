"use client";
import { useMemo, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { Button } from "@/src/components/ui/button";
import { Alert, AlertDescription } from "@/src/components/ui/alert";
import { Field } from "@/src/components/ui/field";

function Confirm({ attemptId }: { attemptId: string }) {
  const stripe = useStripe(); const elements = useElements();
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  return (
    <Field>
      <PaymentElement />
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
      <Button disabled={!stripe || !elements || busy} onClick={async () => {
        if (!stripe || !elements) return;
        setBusy(true); setErr(null);
        try {
        const { error } = await stripe.confirmPayment({ elements, confirmParams: { return_url: `${window.location.origin}/api/returns/${attemptId}` } });
        if (error?.message) setErr(error.message);
        } catch { setErr("Could not confirm payment. Check the order status before retrying."); }
        finally { setBusy(false); }
      }}>{busy ? "Confirming…" : "Confirm payment"}</Button>
    </Field>
  );
}

export default function StripePayment({ clientSecret, publishableKey, attemptId }: { clientSecret: string; publishableKey: string; attemptId: string }) {
  const promise = useMemo(() => loadStripe(publishableKey), [publishableKey]);
  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <Elements stripe={promise} options={{ clientSecret }}>
        <Confirm attemptId={attemptId} />
      </Elements>
    </div>
  );
}
