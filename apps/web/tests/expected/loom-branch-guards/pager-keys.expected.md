# Variant pager keyboard

## Variant 1 of 3
- Previous variant: tabindex -1, aria-disabled
- Next variant: tabindex 0

Tab, Tab, Shift+Tab from Branch several: Next variant → Regenerate once → Next variant
ArrowLeft, ArrowRight: Previous variant → Next variant
Home on variant 1: stays on variant 1 of 3
Enter on Next variant: opens variant 2 of 3

## Variant 2 of 3
- Previous variant: tabindex -1
- Next variant: tabindex 0

- group "Variant 2 of 3":
  - button "Previous variant"
  - button "Next variant"

End: opens variant 3 of 3

## Variant 3 of 3
- Previous variant: tabindex 0
- Next variant: tabindex -1, aria-disabled

Home: opens variant 1 of 3
