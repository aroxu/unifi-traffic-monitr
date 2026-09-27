'use client';

import {Label, ListBox, Select} from '@heroui/react';

export type SelectOption = {value: string; label: string};

export function UiSelect({label, value, options, onValueChange}: {
  label: string;
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
}) {
  return <Select aria-label={label} className="w-full" fullWidth variant="secondary"
    selectedKey={value} onSelectionChange={key => {if (key !== null) onValueChange(String(key));}}>
    <Label>{label}</Label>
    <Select.Trigger className="mt-1 min-h-11 w-full">
      <Select.Value />
      <Select.Indicator />
    </Select.Trigger>
    <Select.Popover>
      <ListBox>
        {options.map(option => <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
          {option.label}<ListBox.ItemIndicator />
        </ListBox.Item>)}
      </ListBox>
    </Select.Popover>
  </Select>;
}
