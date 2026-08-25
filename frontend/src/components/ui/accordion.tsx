import * as React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";

import { cn } from "@/lib/utils";

const Accordion = AccordionPrimitive.Root;

const AccordionItem = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item ref={ref} className={cn("border-b border-hair", className)} {...props} />
));
AccordionItem.displayName = "AccordionItem";

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        "flex flex-1 cursor-pointer items-center justify-between gap-4 py-4 text-left font-body text-[16px] text-ink transition-colors",
        className,
      )}
      {...props}
    >
      {children}
      {/*
        Pluss/minus i en rute i stedet for en chevron. Designet har ingen
        ikoner, og et fortegn leses like umiddelbart som en pil – dessuten
        slipper vi et bibliotek for én glyf. Tilstanden kommer fra `data-state`
        på selve triggeren, som Radix setter. Tegnene roterer forbi hverandre i
        stedet for å byttes brått ut – se `.accordion-glyph` i styles.css.
      */}
      <span
        aria-hidden="true"
        className="accordion-mark grid h-[26px] w-[26px] shrink-0 place-items-center border-2 border-line font-body text-[16px] font-bold leading-none text-ink"
      >
        <span className="accordion-glyph accordion-glyph-plus">+</span>
        <span className="accordion-glyph accordion-glyph-minus">–</span>
      </span>
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Content
    ref={ref}
    className="overflow-hidden font-body text-[15px] data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
    {...props}
  >
    <div className={cn("pb-4 pt-0", className)}>{children}</div>
  </AccordionPrimitive.Content>
));
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
