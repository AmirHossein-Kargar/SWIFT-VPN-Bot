import { adminApiGet } from "@/lib/adminApi.server";
import type { AdminProduct } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ProductsTable } from "@/components/products/products-table";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const products = await adminApiGet<AdminProduct[]>("/products");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Plans &amp; pricing</CardTitle>
          <CardDescription>
            The catalog shown to customers in the Telegram bot. Display order controls the order plans appear in.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ProductsTable items={products} />
        </CardContent>
      </Card>
    </div>
  );
}
