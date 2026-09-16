import type { VariantProps } from 'class-variance-authority'
import { cva } from 'class-variance-authority'

export { default as Button } from './Button.vue'

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-invalid:border-destructive aria-invalid:ring-destructive/30",
  {
    variants: {
      variant: {
        default:
          'bg-primary-cta text-primary-foreground hover:bg-primary-cta-hover active:bg-primary-cta-pressed',
        destructive:
          'bg-destructive text-foreground hover:bg-destructive/90 focus-visible:ring-destructive/40',
        outline: 'border border-control bg-transparent text-foreground hover:bg-surface-raised',
        secondary: 'border border-control bg-transparent text-foreground hover:bg-surface-raised',
        ghost: 'bg-transparent text-foreground hover:bg-surface-raised',
        link: 'text-foreground underline-offset-4 hover:text-accent-caramel hover:underline',
      },
      size: {
        default: 'h-11 px-5 py-2.5 has-[>svg]:px-4',
        xs: "h-8 gap-1 px-2.5 text-xs has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-10 gap-1.5 px-4 has-[>svg]:px-3',
        lg: 'h-12 px-6 has-[>svg]:px-5',
        icon: 'size-11',
        'icon-xs': "size-8 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-10',
        'icon-lg': 'size-12',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)
export type ButtonVariants = VariantProps<typeof buttonVariants>
