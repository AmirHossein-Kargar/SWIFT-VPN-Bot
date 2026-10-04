import axios from "axios";

/** Return live Toman per USD pricing. A stale constant must never price deposits. */
export async function USDPrice() {
  let response;
  try {
    response = await axios.get("https://api.tetherland.com/currencies", { timeout: 8_000 });
  } catch {
    throw new Error("USD/Toman rate provider is unavailable");
  }

  const raw = response.data?.data?.currencies?.USDT?.price;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("USD/Toman rate provider returned an invalid quote");
  }
  return rate;
}

export default USDPrice;
