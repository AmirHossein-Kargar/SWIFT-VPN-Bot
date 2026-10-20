"use client";

import { useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus, Trash2, Send, Eye } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage } from "@/components/ui/form";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { BroadcastProgress } from "@/components/broadcasts/broadcast-progress";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import type { BroadcastPreview } from "@/lib/types";

const broadcastSchema = z.object({
  message: z.string().trim().min(1, "Message is required").max(4096, "Message must be at most 4096 characters"),
  audience: z.enum(["all", "active", "expired", "paying", "custom"]),
  customTelegramIds: z.string().optional(),
  buttons: z
    .array(
      z.object({
        text: z.string().trim().min(1, "Button text is required").max(64, "At most 64 characters"),
        url: z.string().trim().url("Must be a valid URL").refine((value) => /^https:\/\/(t\.me|telegram\.me|telegram\.dog)\//.test(value), "Must be a t.me link"),
      })
    )
    .max(4, "At most 4 buttons"),
});

type BroadcastFormValues = z.infer<typeof broadcastSchema>;

const AUDIENCE_LABEL: Record<string, string> = {
  all: "All users",
  active: "Active in last 30 days",
  expired: "Has an expired service",
  paying: "Has paid at least once",
  custom: "Custom Telegram ID list",
};

export function BroadcastComposer() {
  const { csrfToken } = useAdminSession();
  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);

  const form = useForm<BroadcastFormValues>({
    resolver: zodResolver(broadcastSchema),
    defaultValues: { message: "", audience: "all", customTelegramIds: "", buttons: [] },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "buttons" });
  const audience = form.watch("audience");

  async function doPreview() {
    const values = form.getValues();
    const valid = await form.trigger(["message", "buttons"]);
    if (!valid) return;
    setPreviewing(true);
    try {
      const result = await adminMutate<BroadcastPreview>("/broadcast/preview", "POST", csrfToken, {
        message: values.message,
        buttons: values.buttons,
      });
      setPreview(result);
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Preview failed.");
    } finally {
      setPreviewing(false);
    }
  }

  async function send(values: BroadcastFormValues) {
    setSending(true);
    try {
      const customTelegramIds = values.audience === "custom"
        ? values.customTelegramIds?.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean)
        : undefined;
      const result = await adminMutate<{ started?: boolean; broadcast?: { operationId: string } } & Record<string, unknown>>(
        "/broadcast",
        "POST",
        csrfToken,
        { operationId: newOperationId(), message: values.message, audience: values.audience, customTelegramIds, buttons: values.buttons }
      );
      const operationId = (result.broadcast as { operationId?: string } | undefined)?.operationId;
      toast.success("Broadcast started.");
      setConfirmOpen(false);
      if (typeof operationId === "string") setActiveOperationId(operationId);
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Could not start the broadcast.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      {activeOperationId ? (
        <BroadcastProgress operationId={activeOperationId} onFinished={() => setActiveOperationId(null)} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>New broadcast</CardTitle>
          <CardDescription>Sends a Telegram message to the selected audience. Only one broadcast can run at a time.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(() => setConfirmOpen(true))} className="space-y-4">
              <FormField
                control={form.control}
                name="message"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Message</FormLabel>
                    <FormControl>
                      <Textarea rows={5} placeholder="What would you like to tell your users?" {...field} />
                    </FormControl>
                    <FormDescription>{field.value.length} / 4096 characters</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="audience"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Audience</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-64">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(AUDIENCE_LABEL).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />

              {audience === "custom" ? (
                <FormField
                  control={form.control}
                  name="customTelegramIds"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Telegram IDs</FormLabel>
                      <FormControl>
                        <Textarea rows={3} placeholder="Comma or newline separated: 123456789, 987654321" {...field} />
                      </FormControl>
                      <FormDescription>Up to 10,000 recipients.</FormDescription>
                    </FormItem>
                  )}
                />
              ) : null}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <FormLabel>Buttons (optional, up to 4, t.me links only)</FormLabel>
                  <Button type="button" variant="outline" size="sm" disabled={fields.length >= 4} onClick={() => append({ text: "", url: "" })}>
                    <Plus className="h-3.5 w-3.5" />
                    Add button
                  </Button>
                </div>
                {fields.map((field, index) => (
                  <div key={field.id} className="flex items-start gap-2">
                    <FormField
                      control={form.control}
                      name={`buttons.${index}.text`}
                      render={({ field: inputField }) => (
                        <FormItem className="flex-1">
                          <FormControl>
                            <Input placeholder="Button text" {...inputField} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`buttons.${index}.url`}
                      render={({ field: inputField }) => (
                        <FormItem className="flex-1">
                          <FormControl>
                            <Input placeholder="https://t.me/..." {...inputField} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} aria-label="Remove button">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>

              {preview ? (
                <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
                  <p className="font-medium">Preview</p>
                  <p className="whitespace-pre-wrap text-muted-foreground">{preview.preview.message}</p>
                  <p className="text-xs text-muted-foreground">
                    {preview.preview.characterCount} characters · {preview.preview.lineCount} lines
                  </p>
                  {preview.warnings.map((warning) => (
                    <p key={warning} className="text-xs text-warning">{warning}</p>
                  ))}
                  {preview.validationErrors.map((error) => (
                    <p key={error} className="text-xs text-destructive">{error}</p>
                  ))}
                </div>
              ) : null}

              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={doPreview} disabled={previewing}>
                  <Eye className="h-4 w-4" />
                  Preview
                </Button>
                <Button type="submit" disabled={sending || Boolean(activeOperationId)}>
                  <Send className="h-4 w-4" />
                  Send broadcast
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this broadcast?</AlertDialogTitle>
            <AlertDialogDescription>
              This will message every user in the &ldquo;{AUDIENCE_LABEL[audience]}&rdquo; audience. This cannot be undone once sending starts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={sending} onClick={(event) => { event.preventDefault(); form.handleSubmit(send)(); }}>
              Send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
