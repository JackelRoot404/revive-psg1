import { Checkout } from "./checkout";

export default async function CheckoutPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <main className="checkout-shell"><Checkout sessionId={sessionId} /></main>;
}
