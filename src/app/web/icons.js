// @ts-check
/**
 * The client's icons: 16px line glyphs on a 16×16 grid, stroked in
 * `currentColor` with a non-scaling stroke, so an icon always takes its
 * label's colour (DSH's same-foreground rule).
 *
 * PROVENANCE. The artwork below is DeepSeek Harness's product icon set
 * (`packages/client/ui-primitives/src/icons/artwork.ts` at
 * deepseek-ai/deepseek-harness@2e39e70496aa02986ca6a820c5d497e816b69d7e),
 * MIT-licensed, Copyright (c) 2026 DeepSeek; the licence is reproduced in
 * NOTICE. The glyphs were converted to element data by a one-off script, and
 * renamed for this client; no DeepSeek brand artwork (the whale, the
 * wordmark) is here — MiniDSH's mark is its own (`mark` below).
 *
 * Built with `createElementNS`, never parsed from a string: the page runs
 * under Trusted Types (`require-trusted-types-for 'script'`), which forbids
 * every HTML-parsing sink, `DOMParser` included.
 */

const SVG = 'http://www.w3.org/2000/svg'
/** DSH's regular stroke; its medium (1.3) marks emphasis. */
const REGULAR = 1

/** @typedef {{ size: number, root: Record<string, string>, stroked: boolean, children: [string, Record<string, string>][] }} Glyph */

/** @type {Readonly<Record<string, Glyph>>} */
const GLYPHS = {
  "new-chat":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M8 5V11","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M5 8H11","stroke":"currentColor"}]]},
  "search":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M10.2991 10.3933L14.7783 14.8725","stroke":"currentColor"}]]},
  "settings":{"size":16,"root":{"viewBox":".5 .5 15 15","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z","stroke":"currentColor","stroke-miterlimit":"10"}]]},
  "panel-left":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M5.5 1.5V14.5","stroke":"currentColor"}]]},
  "more":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"d":"M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z","fill":"currentColor"}],["path",{"d":"M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z","fill":"currentColor"}],["path",{"d":"M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z","fill":"currentColor"}]]},
  "plus":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M8 2V14","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2 8H14","stroke":"currentColor"}]]},
  "check":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4","stroke":"currentColor"}]]},
  "branch":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M1.01503 8.0001L5.6964 8.0001C6.41913 8.0001 6.78049 8.0001 7.12115 7.91951C7.4232 7.84804 7.71233 7.73014 7.97821 7.57C8.27809 7.38939 8.5364 7.13669 9.05303 6.63129L11.3281 4.40564","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M1.01221 7.9999L5.6964 7.9999C6.41913 7.9999 6.78049 7.9999 7.12115 8.08049C7.4232 8.15196 7.71233 8.26986 7.97821 8.43C8.27809 8.61061 8.5364 8.86331 9.05303 9.36871L11.3281 11.5944","stroke":"currentColor"}],["circle",{"vector-effect":"non-scaling-stroke","cx":"12.4502","cy":"3.3079","r":"1.56962","stroke":"currentColor"}],["circle",{"vector-effect":"non-scaling-stroke","cx":"12.4502","cy":"12.6921","r":"1.56962","stroke":"currentColor"}]]},
  "chevron-down":{"size":14,"root":{"viewBox":"1 1 14 14","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6","stroke":"currentColor"}]]},
  "chevron-right":{"size":14,"root":{"viewBox":"1 1 14 14","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4","stroke":"currentColor"}]]},
  "chevron-up":{"size":14,"root":{"viewBox":"1 1 14 14","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10","stroke":"currentColor"}]]},
  "close":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M2.5 2.5L13.5 13.5","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M13.5 2.5L2.5 13.5","stroke":"currentColor"}]]},
  "copy":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["rect",{"vector-effect":"non-scaling-stroke","x":"1.52075","y":"4.07373","width":"10.3932","height":"10.3932","rx":"2","stroke":"currentColor"}],["path",{"d":"M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z","fill":"currentColor"}]]},
  "refresh":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M14.4999 1.5V5.1H10.8999","stroke":"currentColor"}]]},
  "edit":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M8.85596 2.19971H4.19971C3.09514 2.19971 2.19971 3.09514 2.19971 4.19971V11.8003C2.19971 12.9049 3.09514 13.8003 4.19971 13.8003H11.8003C12.9049 13.8003 13.8003 12.9049 13.8003 11.8003V7.89893","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M7.7849 8.23878L13.888 2.13574","stroke":"currentColor"}]]},
  "think":{"size":16,"root":{"viewBox":".75 .75 14.5 14.5","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z","stroke":"currentColor"}],["path",{"d":"M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z","fill":"currentColor"}]]},
  "read":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M4.9375 5.90295H11.0625","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M4.9375 9.02991H8.27841","stroke":"currentColor"}],["path",{"d":"M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z","fill":"currentColor"}]]},
  "context":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M5 2.5H3.5C3.23478 2.5 2.98043 2.60536 2.79289 2.79289C2.60536 2.98043 2.5 3.23478 2.5 3.5V13.5C2.5 13.7652 2.60536 14.0196 2.79289 14.2071C2.98043 14.3946 3.23478 14.5 3.5 14.5H12.5C12.7652 14.5 13.0196 14.3946 13.2071 14.2071C13.3946 14.0196 13.5 13.7652 13.5 13.5V3.5C13.5 3.23478 13.3946 2.98043 13.2071 2.79289C13.0196 2.60536 12.7652 2.5 12.5 2.5H11","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M8 0.5V7.5","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M5.5 5L8 7.5L10.5 5","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M5.5 11H10.5","stroke":"currentColor"}]]},
  "link":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M6.59961 9.40051C6.82779 9.6334 7.10015 9.81842 7.40074 9.94472C7.70132 10.071 8.02409 10.1361 8.35013 10.1361C8.67618 10.1361 8.99894 10.071 9.29953 9.94472C9.60011 9.81842 9.87247 9.6334 10.1007 9.40051L12.9015 6.59967C13.3658 6.13541 13.6266 5.50572 13.6266 4.84915C13.6266 4.19258 13.3658 3.56289 12.9015 3.09863C12.4372 2.63436 11.8075 2.37354 11.151 2.37354C10.4944 2.37354 9.86472 2.63436 9.40045 3.09863L9.05034 3.44873","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M9.40051 6.59959C9.17233 6.3667 8.89997 6.18169 8.59939 6.05538C8.2988 5.92907 7.97603 5.86401 7.64999 5.86401C7.32395 5.86401 7.00118 5.92907 6.70059 6.05538C6.40001 6.18169 6.12765 6.3667 5.89946 6.59959L3.09863 9.40043C2.63436 9.8647 2.37354 10.4944 2.37354 11.151C2.37354 11.8075 2.63436 12.4372 3.09863 12.9015C3.56289 13.3657 4.19258 13.6266 4.84915 13.6266C5.50572 13.6266 6.13541 13.3657 6.59967 12.9015L6.94978 12.5514","stroke":"currentColor"}]]},
  "open":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"d":"M11.7256 2.77441C12.5538 2.77469 13.2256 3.44616 13.2256 4.27441V10.1416H12.2256V4.27441C12.2256 3.99844 12.0015 3.77469 11.7256 3.77441H5.7207V2.77441H11.7256Z","fill":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2.77441 13.2255L12.3756 3.62427","stroke":"currentColor"}]]},
  "warning":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M8 4.29199V9.79199","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M8 10.708V11.708","stroke":"currentColor"}]]},
  "warning-triangle":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none","stroke-linecap":"round","stroke-linejoin":"round"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M6.87 2.6a1.33 1.33 0 0 1 2.26 0l5.34 9.33A1.33 1.33 0 0 1 13.33 14H2.67a1.33 1.33 0 0 1-1.14-2.07Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M8 6v3m0 2.33h.01","stroke":"currentColor"}]]},
  "check-circle":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["circle",{"vector-effect":"non-scaling-stroke","cx":"8","cy":"8","r":"6.5","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M4.5 8L7 10.5L11.5 6","stroke":"currentColor","stroke-linejoin":"round"}]]},
  "users":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M6.18 8.2275C7.5620898 8.2275 8.6825 7.1070898 8.6825 5.725C8.6825 4.3429102 7.5620898 3.2225 6.18 3.2225C4.7979102 3.2225 3.6775 4.3429102 3.6775 5.725C3.6775 7.1070898 4.7979102 8.2275 6.18 8.2275Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M1.63 13.915C1.63 11.185 3.905 10.0475 6.18 10.0475C8.455 10.0475 10.73 11.185 10.73 13.915","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M10.275 3.359C11.3215 3.7685 12.0495 4.6785 12.0495 5.725C12.0495 6.7715 11.3215 7.6815 10.275 8.091","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M12.004 10.366C13.369 11.003 14.37 12.186 14.37 13.915","stroke":"currentColor"}]]},
  "user":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["circle",{"vector-effect":"non-scaling-stroke","cx":"8","cy":"4.5","r":"2.75","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M1.5 14C1.5 10.75 4.75 9.5 8 9.5C11.25 9.5 14.5 10.75 14.5 14","stroke":"currentColor"}]]},
  "stop":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"d":"M12.5 2.5H3.5C2.94772 2.5 2.5 2.94772 2.5 3.5V12.5C2.5 13.0523 2.94772 13.5 3.5 13.5H12.5C13.0523 13.5 13.5 13.0523 13.5 12.5V3.5C13.5 2.94772 13.0523 2.5 12.5 2.5Z","fill":"currentColor"}]]},
  "loading":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M12.596 12.596C11.687 13.5049 10.5288 14.1239 9.26798 14.3747C8.00716 14.6255 6.70028 14.4968 5.51261 14.0048C4.32494 13.5129 3.30981 12.6798 2.59557 11.611C1.88134 10.5421 1.50008 9.2855 1.5 7.99998C1.50008 6.71446 1.88134 5.45783 2.59557 4.38898C3.30981 3.32013 4.32494 2.48707 5.51261 1.99513C6.70028 1.50319 8.00716 1.37447 9.26798 1.62524C10.5288 1.87602 11.687 2.49502 12.596 3.40398","stroke":"currentColor"}]]},
  "code":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M6.27612 1.5L4.52612 14.5","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M11.4739 1.5L9.72388 14.5","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2.39868 5.5H14.0681","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M1.93188 10.5H13.6013","stroke":"currentColor"}]]},
  "terminal":{"size":14,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M2 3L7 8L2 13","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M9 13H14","stroke":"currentColor"}]]},
  "folder-open":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M12.3994 13.5986H2.04956C1.49728 13.5986 1.04956 13.1509 1.04956 12.5986V3.40137C1.04956 2.84908 1.49728 2.40137 2.04956 2.40137H4.76632C5.01016 2.40137 5.24561 2.49046 5.42836 2.6519L6.94088 3.98799C7.12364 4.14943 7.35908 4.23852 7.60293 4.23852H12.3994C12.9517 4.23852 13.3994 4.68624 13.3994 5.23852V7.16991","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2.55911 7.93683C2.67584 7.49906 3.07229 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55911 7.93683Z","stroke":"currentColor"}]]},
  "folder":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M3.63501 7.66614H12.3647","stroke":"currentColor"}]]},
  "light":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M8.00007 11.8117C10.1052 11.8117 11.8117 10.1052 11.8117 8.00007C11.8117 5.89499 10.1052 4.18848 8.00007 4.18848C5.89499 4.18848 4.18848 5.89499 4.18848 8.00007C4.18848 10.1052 5.89499 11.8117 8.00007 11.8117Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M13.3899 8H15.1499","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M11.8115 11.8115L13.0556 13.0556","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M8 13.3901V15.1501","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M4.18868 11.8115L2.94458 13.0556","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2.6101 8H0.850098","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M4.18868 4.18856L2.94458 2.94446","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M8 2.6101V0.850098","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M11.8115 4.18856L13.0556 2.94446","stroke":"currentColor"}]]},
  "dark":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M14.1127 8.70663C14.2576 8.60602 14.4627 8.71355 14.4386 8.88834C14.2901 9.96567 13.8731 10.9912 13.2229 11.8692C12.479 12.8735 11.4613 13.6421 10.2917 14.0829C9.1222 14.5236 7.85038 14.6179 6.62865 14.3543C5.40692 14.0907 4.28709 13.4805 3.40332 12.5967C2.51955 11.7129 1.90931 10.5931 1.64572 9.37135C1.38212 8.14962 1.47635 6.87779 1.91711 5.70825C2.35787 4.5387 3.12647 3.52103 4.13083 2.77714C5.00878 2.12689 6.03433 1.70994 7.11166 1.5614C7.28645 1.5373 7.39397 1.74238 7.29337 1.88734C6.68703 2.76099 6.37885 3.81241 6.42313 4.88345C6.47392 6.11194 6.98471 7.27645 7.85413 8.14587C8.72355 9.01529 9.88805 9.52608 11.1166 9.57687C12.1876 9.62114 13.239 9.31296 14.1127 8.70663Z","stroke":"currentColor"}]]},
  "system":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M13.5 2.5H2.5C1.94772 2.5 1.5 2.94772 1.5 3.5V11.5C1.5 12.0523 1.94772 12.5 2.5 12.5H13.5C14.0523 12.5 14.5 12.0523 14.5 11.5V3.5C14.5 2.94772 14.0523 2.5 13.5 2.5Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M5 14.5H11","stroke":"currentColor"}]]},
  "database":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M13.1967 5.1869C13.7232 4.77378 14.0003 4.30517 14.0001 3.82819C14.0003 3.3512 13.7232 2.88259 13.1967 2.46947C12.6702 2.05635 11.9128 1.71328 11.0006 1.47475C10.0885 1.23621 9.05371 1.11062 8.00039 1.1106C6.94707 1.11057 5.9123 1.23612 5.00009 1.47461C4.08742 1.71301 3.32948 2.05604 2.80249 2.46919C2.2755 2.88235 1.99805 3.35106 1.99805 3.82819C1.99805 4.30531 2.2755 4.77402 2.80249 5.18718C3.32948 5.60033 4.08742 5.94336 5.00009 6.18176C5.9123 6.42025 6.94707 6.5458 8.00039 6.54578C9.05371 6.54575 10.0885 6.42016 11.0006 6.18163C11.9128 5.94309 12.6702 5.60002 13.1967 5.1869Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2 3.80371V11.7848","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M14 3.80371V11.7848","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2 7.81396C2 8.60524 2.63214 9.36411 3.75736 9.92363C4.88258 10.4832 6.4087 10.7975 8 10.7975C9.5913 10.7975 11.1174 10.4832 12.2426 9.92363C13.3679 9.36411 14 8.60524 14 7.81396","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2 11.7847C2 12.6081 2.63214 13.3977 3.75736 13.98C4.88258 14.5622 6.4087 14.8893 8 14.8893C9.5913 14.8893 11.1174 14.5622 12.2426 13.98C13.3679 13.3977 14 12.6081 14 11.7847","stroke":"currentColor"}]]},
  "clock":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["circle",{"vector-effect":"non-scaling-stroke","cx":"8","cy":"8","r":"6.5","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M8 4V8.5L11 10","stroke":"currentColor"}]]},
  "gauge":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M3.4041 13.096C2.49514 12.187 1.87614 11.0288 1.62537 9.76798C1.37459 8.50716 1.50331 7.20028 1.99525 6.01261C2.48719 4.82494 3.32025 3.80981 4.3891 3.09557C5.45795 2.38134 6.71458 2.00008 8.0001 2C9.28563 2.00008 10.5423 2.38134 11.6111 3.09557C12.68 3.80981 13.513 4.82494 14.005 6.01261C14.4969 7.20028 14.6256 8.50716 14.3748 9.76798C14.1241 11.0288 13.5051 12.187 12.5961 13.096","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M8 8.49994L11.6114 4.88855","stroke":"currentColor"}],["path",{"d":"M8 9.75C8.69036 9.75 9.25 9.19036 9.25 8.5C9.25 7.80964 8.69036 7.25 8 7.25C7.30964 7.25 6.75 7.80964 6.75 8.5C6.75 9.19036 7.30964 9.75 8 9.75Z","fill":"currentColor"}]]},
  "globe":{"size":14,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M7.99986 14.0887C11.3626 14.0887 14.0886 11.3627 14.0886 7.99998C14.0886 4.63727 11.3626 1.91125 7.99986 1.91125C4.63715 1.91125 1.91113 4.63727 1.91113 7.99998C1.91113 11.3627 4.63715 14.0887 7.99986 14.0887Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2.34619 8H13.6538","stroke":"currentColor","stroke-linecap":"square"}],["path",{"vector-effect":"non-scaling-stroke","d":"M7.99976 14.0889C9.23509 14.0889 10.1743 11.3629 10.1743 8.00006C10.1743 4.63739 9.23509 1.91138 7.99976 1.91138","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M7.99973 14.0889C6.76445 14.0889 5.8252 11.3629 5.8252 8.00006C5.8252 4.63739 6.76445 1.91138 7.99973 1.91138","stroke":"currentColor"}]]},
  "layers":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none","stroke-linecap":"round","stroke-linejoin":"round"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M8.481371 2.304371 a1.159971 1.159971 0 0 0-.962742 0 L2.547971 4.566371 a.580029 .580029 0 0 0 0 1.0614 l4.9764 2.267829 a1.159971 1.159971 0 0 0 .962829 0 l4.9764-2.262 a.580029 .580029 0 0 0 0-1.0614Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2.199971 8 a.580029 .580029 0 0 0 .336429 .527829 l4.987971 2.267742 a1.159971 1.159971 0 0 0 .957 0 l4.9764-2.262 A.580029 .580029 0 0 0 13.800029 8","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2.199971 10.899971 a.580029 .580029 0 0 0 .336429 .527829 l4.987971 2.267829 a1.159971 1.159971 0 0 0 .957 0 l4.9764-2.262 A.580029 .580029 0 0 0 13.800029 10.899971","stroke":"currentColor"}]]},
  "compact":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","opacity":"0.35","d":"M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M8 1.5C8.85359 1.5 9.69883 1.66813 10.4874 1.99478C11.2761 2.32144 11.9926 2.80022 12.5962 3.40381C13.1998 4.00739 13.6786 4.72394 14.0052 5.51256C14.3319 6.30117 14.5 7.14641 14.5 8","stroke":"currentColor"}]]},
  "shield":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M6.80132 2.14853C7.70663 1.80917 8.70422 1.80919 9.60952 2.14859L14.1296 3.84317V7.11961C14.1296 11.6089 10.7615 13.5975 8.20543 14.5779C5.64931 13.5975 2.28052 11.6089 2.28052 7.11961V3.84317L6.80132 2.14853Z","stroke":"currentColor","stroke-linejoin":"round"}]]},
  "inspect":{"size":12,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M4.67398 4.25061L1.36094 7.86484C1.29085 7.9413 1.29085 8.05866 1.36094 8.13513L4.67398 11.7494","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M11.3262 4.25061L14.6392 7.86484C14.7093 7.9413 14.7093 8.05866 14.6392 8.13513L11.3262 11.7494","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M9.56222 3.62573L6.43774 12.3743","stroke":"currentColor"}]]},
  "info":{"size":14,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["circle",{"vector-effect":"non-scaling-stroke","cx":"8","cy":"8","r":"6.5","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M8 7V11M8 4.5V5.5","stroke":"currentColor"}]]},
  "sparkle":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z","stroke":"currentColor"}]]},
  "skill":{"size":16,"root":{"viewBox":"-.25 -.25 17 17","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M4.57788 5.77124H10.7029","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M4.57788 8.89819H7.91879","stroke":"currentColor"}],["path",{"d":"M12.1404 1.19446C12.9442 1.19446 13.6404 1.81999 13.6404 2.64465V8.89856H12.6404V2.64465C12.6404 2.42015 12.4411 2.19446 12.1404 2.19446H3.14038C2.83968 2.19446 2.64038 2.42015 2.64038 2.64465V13.0929C2.64082 13.3172 2.84001 13.5421 3.14038 13.5421H8.88159V14.5421H3.14038C2.33675 14.5421 1.6408 13.9172 1.64038 13.0929V2.64465C1.64038 1.81999 2.33651 1.19446 3.14038 1.19446H12.1404Z","fill":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M12.0051 15.1056C12.0051 13.6395 10.8166 12.451 9.35059 12.451C10.8166 12.451 12.0051 11.2626 12.0051 9.79651C12.0051 11.2626 13.1936 12.451 14.6597 12.451C13.1936 12.451 12.0051 13.6395 12.0051 15.1056Z","stroke":"currentColor"}]]},
  "diff":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M4.5 4.5V3C4.5 2.17157 5.17157 1.5 6 1.5H13C13.8284 1.5 14.5 2.17157 14.5 3V10C14.5 10.8284 13.8284 11.5 13 11.5H11.5","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M10 4.5H3C2.17157 4.5 1.5 5.17157 1.5 6V13C1.5 13.8284 2.17157 14.5 3 14.5H10C10.8284 14.5 11.5 13.8284 11.5 13V6C11.5 5.17157 10.8284 4.5 10 4.5Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M4.75 8H8.25M6.5 6.25V9.75","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M4.75 12H8.25","stroke":"currentColor"}]]},
  "image":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M1.5 8C3.36 4.41 5.52 2.63 8 2.63C10.48 2.63 12.64 4.41 14.5 8C12.64 11.59 10.48 13.37 8 13.37C5.52 13.37 3.36 11.59 1.5 8Z","stroke":"currentColor"}],["circle",{"vector-effect":"non-scaling-stroke","cx":"8","cy":"8","r":"2.25","stroke":"currentColor"}]]},
  "wrap":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M2.3457 3.19299H13.6541","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2.3457 7.46497H9.19332","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2.3457 11.7369H6.4849","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M9.1936 7.46497H11.5183C12.6981 7.46497 13.6544 8.42132 13.6544 9.60103C13.6544 10.7808 12.6981 11.7371 11.5183 11.7371H9.1936","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M10.9505 9.7677L9.12262 11.5956C9.04452 11.6737 9.04452 11.8003 9.12262 11.8784L10.9505 13.7063","stroke":"currentColor"}]]},
  "send":{"size":14,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"d":"M6.97211 1.94476C7.55785 1.35914 8.50767 1.35919 9.09343 1.94476L13.921 6.77228L13.2138 7.47939L8.38632 2.65187C8.19108 2.45682 7.87443 2.45677 7.67922 2.65187L2.74397 7.58711L2.03687 6.88L6.97211 1.94476Z","fill":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M7.97571 14.5732L8.02421 2.34139","stroke":"currentColor"}]]},
  "queue":{"size":14,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M5 6.75H11","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M5 9H8","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2.37067 11.2497C1.5872 9.89252 1.32042 8.29798 1.61945 6.7597C1.91847 5.22141 2.76317 3.84293 3.99801 2.87809C5.23285 1.91325 6.7747 1.427 8.33964 1.50888C9.90458 1.59076 11.3873 2.23526 12.5147 3.32369C13.6422 4.41232 14.3384 5.8717 14.4751 7.43304C14.6118 8.99438 14.1797 10.5525 13.2585 11.8205C12.3372 13.0885 10.9889 13.9809 9.4617 14.3334C8.18666 14.6277 6.8587 14.529 5.64964 14.0601C5.17095 13.8745 4.76937 13.4929 4.26509 13.3963C3.67389 13.2832 2.95232 13.5595 2.0377 14.3334","stroke":"currentColor"}]]},
  "sliders":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M1.5 5H8.5M11.5 5H14.5M1.5 11H4.5M7.5 11H14.5","stroke":"currentColor"}],["circle",{"vector-effect":"non-scaling-stroke","cx":"10","cy":"5","r":"1.5","stroke":"currentColor"}],["circle",{"vector-effect":"non-scaling-stroke","cx":"6","cy":"11","r":"1.5","stroke":"currentColor"}]]},
  "archive":{"size":20,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M13.5 2.5H2.5C1.94772 2.5 1.5 2.94772 1.5 3.5V4.5C1.5 5.05228 1.94772 5.5 2.5 5.5H13.5C14.0523 5.5 14.5 5.05228 14.5 4.5V3.5C14.5 2.94772 14.0523 2.5 13.5 2.5Z","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M2.5 5.5V13.5C2.5 13.7652 2.60536 14.0196 2.79289 14.2071C2.98043 14.3946 3.23478 14.5 3.5 14.5H12.5C12.7652 14.5 13.0196 14.3946 13.2071 14.2071C13.3946 14.0196 13.5 13.7652 13.5 13.5V5.5","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M6.5 9.5H9.5","stroke":"currentColor"}]]},
  "download":{"size":16,"root":{"viewBox":"0 0 16 16","fill":"none"},
  "stroked":true,"children":[["path",{"vector-effect":"non-scaling-stroke","d":"M8 1.95317V10.0469","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M4.25 6.29688L8 10.0469L11.75 6.29688","stroke":"currentColor"}],["path",{"vector-effect":"non-scaling-stroke","d":"M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469","stroke":"currentColor"}]]}
}

/** @typedef {keyof typeof GLYPHS} IconName */

/**
 * One glyph as an inline SVG, hidden from assistive technology: the control
 * it sits in carries the name.
 * @param {string} name
 * @param {{ size?: number, weight?: number, className?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, options = {}) {
  const glyph = GLYPHS[name]
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('class', `icon${options.className ? ` ${options.className}` : ''}`)
  if (!glyph) return svg
  const size = options.size ?? glyph.size
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  for (const [key, value] of Object.entries(glyph.root)) svg.setAttribute(key, value)
  if (glyph.stroked) svg.setAttribute('stroke-width', String(options.weight ?? REGULAR))
  for (const [tag, attrs] of glyph.children) {
    const child = document.createElementNS(SVG, tag)
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value)
    svg.append(child)
  }
  return svg
}

/**
 * MiniDSH's own mark: a rounded tile holding two strokes that meet like a
 * harness strap — drawn here, not taken from anyone's brand.
 * @param {number} [size]
 * @returns {SVGSVGElement}
 */
export function mark(size = 22) {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('class', 'mark')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  const tile = document.createElementNS(SVG, 'rect')
  for (const [key, value] of Object.entries({ x: '1', y: '1', width: '22', height: '22', rx: '7', class: 'mark-tile' })) tile.setAttribute(key, value)
  const strap = document.createElementNS(SVG, 'path')
  for (const [key, value] of Object.entries({ d: 'M6.5 16.5V9.5a2.5 2.5 0 0 1 5 0v7M11.5 9.5a2.5 2.5 0 0 1 5 0v7', class: 'mark-strap', fill: 'none', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) strap.setAttribute(key, value)
  const dot = document.createElementNS(SVG, 'circle')
  for (const [key, value] of Object.entries({ cx: '17.75', cy: '6.25', r: '1.6', class: 'mark-dot' })) dot.setAttribute(key, value)
  svg.append(tile, strap, dot)
  return svg
}

/** Every icon name, for the tests. */
export const ICON_NAMES = Object.freeze(Object.keys(GLYPHS))
