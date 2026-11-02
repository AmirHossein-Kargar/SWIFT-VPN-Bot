import * as React from "react";

import { ScrollRegion } from "@/components/ui/scroll-region";
import { cn } from "@/lib/utils";

interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /** Names the scroller for keyboard and screen reader users, when the table is wider than the screen. */
  label?: string;
  /**
   * Below `md`, each row becomes a card and each cell shows its `label`, so nothing sits behind a sideways scroll.
   * `"xl"` keeps the cards up to `xl`, for a table too wide for a tablet or a laptop beside the sidebar.
   */
  stack?: boolean | "xl";
}

// Explicit roles: `.table-stack` changes `display`, and browsers drop table semantics when it does.
const Table = React.forwardRef<HTMLTableElement, TableProps>(({ className, label = "Table", stack = false, ...props }, ref) => (
  <ScrollRegion label={label}>
    <table ref={ref} role="table" className={cn("w-full caption-bottom text-sm", stack === "xl" ? "table-stack-xl" : stack && "table-stack", className)} {...props} />
  </ScrollRegion>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => (
  <thead ref={ref} role="rowgroup" className={cn("[&_tr]:border-b [&_tr]:border-border", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => (
  <tbody ref={ref} role="rowgroup" className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => (
  <tfoot ref={ref} className={cn("border-t border-border bg-muted/50 font-medium", className)} {...props} />
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(({ className, ...props }, ref) => (
  <tr ref={ref} role="row" className={cn("border-b border-border transition-colors hover:bg-muted/40 data-[state=selected]:bg-muted", className)} {...props} />
));
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(({ className, ...props }, ref) => (
  <th ref={ref} role="columnheader" scope="col" className={cn("h-10 px-3 text-left align-middle text-xs font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0", className)} {...props} />
));
TableHead.displayName = "TableHead";

interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  /** The column name, shown above the value when a `stack` table is in its card layout. */
  label?: string;
  /** Takes a whole row of the card: the row's title, a long id, or its actions. */
  wide?: boolean;
  /** Holds the row's menu or checkbox, which pins to the card's top corner. */
  corner?: boolean;
}

const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(({ className, label, wide, corner, ...props }, ref) => (
  <td ref={ref} role="cell" data-label={label} data-wide={wide ? "" : undefined} data-corner={corner ? "" : undefined} className={cn("p-3 align-middle [&:has([role=checkbox])]:pr-0", className)} {...props} />
));
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
