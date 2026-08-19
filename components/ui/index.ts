/**
 * The single door into the design system.
 *
 * Screens import from `@/components/ui`, never from individual files — so
 * rearranging the internals does not mean editing twenty call sites.
 */

export { cn, type ClassValue } from "./cn";
export { Icon, ICON_NAMES, type IconName } from "./icon";
export { Spinner } from "./spinner";

export { Button, ButtonLink, IconButton, type ButtonSize, type ButtonVariant } from "./button";
export { Field, FieldGroup } from "./field";
export { Input, CONTROL_BASE, CONTROL_BORDER, CONTROL_INVALID } from "./input";
export { Select } from "./select";
export { Textarea } from "./textarea";
export { Checkbox } from "./checkbox";
export { RadioGroup, type RadioOption } from "./radio";
export { Switch } from "./switch";
export { Combobox, ComboboxHint, foldVietnamese, type ComboboxOption } from "./combobox";
export { TagInput } from "./tag-input";
export { FileDropzone, formatBytes } from "./file-dropzone";
export { Segmented, type SegmentedOption } from "./segmented";

export { Card, CardBody, CardFooter, CardHeader } from "./card";
export { Panel } from "./panel";
export { Tabs, TabPanel, type TabItem } from "./tabs";
export { DataTable, BulkBar, type Column, type SortState, type SortDirection } from "./table";

export { Badge, type Tone } from "./badge";
export { StatusPill } from "./status-pill";
export { ProgressBar, StackedBar } from "./progress-bar";
export { Alert, AlertList } from "./alert";
export { EmptyState } from "./empty-state";
export { Skeleton, SkeletonCards, SkeletonTable } from "./skeleton";
export { ErrorState } from "./error-state";
export { DescriptionList, type DescriptionItem } from "./description-list";
export { Stat } from "./stat";
export { CopyButton } from "./copy-button";
export { Code, CodeBlock } from "./code-block";
export { Tooltip } from "./tooltip";

export { Modal, ConfirmDialog } from "./modal";
export { Drawer } from "./drawer";
export { ToastProvider, useToast, type Toast } from "./toast";

export { Sparkline, BarChart, type BarDatum } from "./chart";
export { DateTime, ElapsedTime, RelativeTime, useHydrated } from "./client-time";
export { useDismiss, useFocusTrap, useScrollLock } from "./use-dismiss";
