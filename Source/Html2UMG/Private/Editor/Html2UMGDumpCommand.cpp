// Copyright (c) 2026 FPVSkyline. MIT License.
//
// Html2UMG.DumpWidgets - prove what actually landed in a Widget Blueprint.
//
//   UnrealEditor.exe <uproject> -ExecCmds="Html2UMG.DumpWidgets /Game/UI/WBP_X --json=C:/w/dump.json, QUIT_EDITOR" -unattended -nosplash
//
// The JSON is the machine-readable contract used by Resources/Tools/style_audit.py:
//
//   {
//     "blueprint": "/Game/UI/WBP_X",
//     "widgets": [
//       { "class": "ComboBoxString", "name": "FlightMode", "variable": true, "parent": "Panel_Content",
//         "properties": { "<dotted.property.path>": <value>, ... } }
//     ]
//   }
//
// Values: colours are [r,g,b,a] linear (4 decimals), vectors/margins are arrays, enums are names,
// everything else is a number/bool/string. Defaults are always emitted, so "not written" and
// "written to the default" are distinguishable.
//
// NOTE: -ExecCmds splits on COMMAS, not semicolons.

#include "CoreMinimal.h"

#include "Blueprint/WidgetTree.h"
#include "Components/PanelWidget.h"
#include "Components/Widget.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Fonts/SlateFontInfo.h"
#include "HAL/IConsoleManager.h"
#include "Html2UMGLog.h"
#include "Layout/Margin.h"
#include "Math/Color.h"
#include "Math/Vector2D.h"
#include "Math/Vector4.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Styling/SlateBrush.h"
#include "Styling/SlateColor.h"
#include "Styling/SlateTypes.h"
#include "UObject/EnumProperty.h"
#include "UObject/TextProperty.h"
#include "UObject/UnrealType.h"
#include "WidgetBlueprint.h"

namespace
{
	/** Flat dotted path -> JSON value, per widget. */
	using FFlatProperties = TMap<FString, TSharedPtr<FJsonValue>>;

	struct FDumpOptions
	{
		/** Include non-editable UPROPERTYs too (diagnostics). */
		bool bDeep = false;
		/** Struct recursion stops here; deeper structs are emitted as exported text. */
		int32 MaxDepth = 8;
	};

	// ---------------------------------------------------------------- formatting

	double Round4(double Value)
	{
		return FMath::RoundToDouble(Value * 10000.0) / 10000.0;
	}

	TSharedPtr<FJsonValue> MakeNumber(double Value)
	{
		return MakeShared<FJsonValueNumber>(Round4(Value));
	}

	TSharedPtr<FJsonValue> MakeString(const FString& Value)
	{
		return MakeShared<FJsonValueString>(Value);
	}

	TSharedPtr<FJsonValue> MakeBool(bool bValue)
	{
		return MakeShared<FJsonValueBoolean>(bValue);
	}

	TSharedPtr<FJsonValue> MakeArray(const TArray<TSharedPtr<FJsonValue>>& Items)
	{
		return MakeShared<FJsonValueArray>(Items);
	}

	TSharedPtr<FJsonValue> MakeColorArray(const FLinearColor& Color)
	{
		TArray<TSharedPtr<FJsonValue>> Items;
		Items.Reserve(4);
		Items.Add(MakeNumber(Color.R));
		Items.Add(MakeNumber(Color.G));
		Items.Add(MakeNumber(Color.B));
		Items.Add(MakeNumber(Color.A));
		return MakeArray(Items);
	}

	TSharedPtr<FJsonValue> MakeVector4Array(const FVector4& Vector)
	{
		TArray<TSharedPtr<FJsonValue>> Items;
		Items.Reserve(4);
		Items.Add(MakeNumber(Vector.X));
		Items.Add(MakeNumber(Vector.Y));
		Items.Add(MakeNumber(Vector.Z));
		Items.Add(MakeNumber(Vector.W));
		return MakeArray(Items);
	}

	TSharedPtr<FJsonValue> MakeVector2Array(const FVector2D& Vector)
	{
		TArray<TSharedPtr<FJsonValue>> Items;
		Items.Reserve(2);
		Items.Add(MakeNumber(Vector.X));
		Items.Add(MakeNumber(Vector.Y));
		return MakeArray(Items);
	}

	TSharedPtr<FJsonValue> MakeMarginArray(const FMargin& Margin)
	{
		TArray<TSharedPtr<FJsonValue>> Items;
		Items.Reserve(4);
		Items.Add(MakeNumber(Margin.Left));
		Items.Add(MakeNumber(Margin.Top));
		Items.Add(MakeNumber(Margin.Right));
		Items.Add(MakeNumber(Margin.Bottom));
		return MakeArray(Items);
	}

	/** "ECheckBoxState::Checked" -> "Checked" */
	FString ShortEnumName(const UEnum* Enum, int64 Value)
	{
		if (!Enum)
		{
			return FString::Printf(TEXT("%lld"), Value);
		}

		FString Name = Enum->GetNameStringByValue(Value);
		if (Name.IsEmpty())
		{
			return FString::Printf(TEXT("%lld"), Value);
		}

		int32 SeparatorIndex = INDEX_NONE;
		if (Name.FindLastChar(TEXT(':'), SeparatorIndex))
		{
			Name = Name.RightChop(SeparatorIndex + 1);
		}
		return Name;
	}

	FString JoinPath(const FString& Prefix, const FString& Name)
	{
		return Prefix.IsEmpty() ? Name : Prefix + TEXT(".") + Name;
	}

	/** Scalar view of any property, used for array elements and for leaf structs. */
	TSharedPtr<FJsonValue> ScalarValue(FProperty* Property, const void* ValuePtr)
	{
		if (!Property || !ValuePtr)
		{
			return MakeString(TEXT("<null>"));
		}

		if (const FBoolProperty* BoolProperty = CastField<FBoolProperty>(Property))
		{
			return MakeBool(BoolProperty->GetPropertyValue(ValuePtr));
		}

		if (const FByteProperty* ByteProperty = CastField<FByteProperty>(Property))
		{
			if (ByteProperty->Enum)
			{
				return MakeString(ShortEnumName(ByteProperty->Enum, ByteProperty->GetPropertyValue(ValuePtr)));
			}
			return MakeNumber(ByteProperty->GetPropertyValue(ValuePtr));
		}

		if (const FEnumProperty* EnumProperty = CastField<FEnumProperty>(Property))
		{
			int64 Raw = 0;
			if (const FNumericProperty* Underlying = EnumProperty->GetUnderlyingProperty())
			{
				Raw = Underlying->GetSignedIntPropertyValue(ValuePtr);
			}
			return MakeString(ShortEnumName(EnumProperty->GetEnum(), Raw));
		}

		if (const FNumericProperty* NumericProperty = CastField<FNumericProperty>(Property))
		{
			if (NumericProperty->IsFloatingPoint())
			{
				return MakeNumber(NumericProperty->GetFloatingPointPropertyValue(ValuePtr));
			}
			return MakeNumber(static_cast<double>(NumericProperty->GetSignedIntPropertyValue(ValuePtr)));
		}

		if (const FStrProperty* StringProperty = CastField<FStrProperty>(Property))
		{
			return MakeString(StringProperty->GetPropertyValue(ValuePtr));
		}

		if (const FNameProperty* NameProperty = CastField<FNameProperty>(Property))
		{
			return MakeString(NameProperty->GetPropertyValue(ValuePtr).ToString());
		}

		if (const FTextProperty* TextProperty = CastField<FTextProperty>(Property))
		{
			return MakeString(TextProperty->GetPropertyValue(ValuePtr).ToString());
		}

		if (const FObjectProperty* ObjectProperty = CastField<FObjectProperty>(Property))
		{
			if (const UObject* Object = ObjectProperty->GetObjectPropertyValue(ValuePtr))
			{
				return MakeString(Object->GetPathName());
			}
			return MakeString(TEXT("None"));
		}

		if (const FSoftObjectProperty* SoftProperty = CastField<FSoftObjectProperty>(Property))
		{
			const FSoftObjectPtr* SoftPtr = static_cast<const FSoftObjectPtr*>(ValuePtr);
			return MakeString(SoftPtr->ToSoftObjectPath().ToString());
		}

		if (const FStructProperty* StructProperty = CastField<FStructProperty>(Property))
		{
			FString Exported;
			Property->ExportTextItem_Direct(Exported, ValuePtr, nullptr, nullptr, PPF_None);
			return MakeString(Exported);
		}

		return MakeString(TEXT("<unsupported>"));
	}

	// ---------------------------------------------------------------- expansion

	void EmitProperty(const FString& Path, FProperty* Property, const void* ValuePtr, const FDumpOptions& Options, int32 Depth, FFlatProperties& Out);
	void EmitStruct(const FString& Path, const UScriptStruct* Struct, const void* ValuePtr, const FDumpOptions& Options, int32 Depth, FFlatProperties& Out);
	void EmitStructFields(const FString& Path, const UScriptStruct* Struct, const void* ValuePtr, const FDumpOptions& Options, int32 Depth, FFlatProperties& Out);

	/** FSlateBrush expands into the fields the style audit compares. */
	void EmitBrush(const FString& Path, const FSlateBrush& Brush, FFlatProperties& Out)
	{
		Out.Add(JoinPath(Path, TEXT("TintColor")), MakeColorArray(Brush.TintColor.GetSpecifiedColor()));
		Out.Add(JoinPath(Path, TEXT("DrawAs")), MakeString(ShortEnumName(StaticEnum<ESlateBrushDrawType::Type>(), Brush.GetDrawType())));
		Out.Add(JoinPath(Path, TEXT("OutlineSettings.Width")), MakeNumber(Brush.OutlineSettings.Width));
		Out.Add(JoinPath(Path, TEXT("OutlineSettings.Color")), MakeColorArray(Brush.OutlineSettings.Color.GetSpecifiedColor()));
		Out.Add(JoinPath(Path, TEXT("OutlineSettings.CornerRadii")), MakeVector4Array(Brush.OutlineSettings.CornerRadii));
		Out.Add(JoinPath(Path, TEXT("Margin")), MakeMarginArray(Brush.Margin));
		Out.Add(JoinPath(Path, TEXT("ImageSize")), MakeVector2Array(FVector2D(Brush.ImageSize.X, Brush.ImageSize.Y)));
		Out.Add(JoinPath(Path, TEXT("Tiling")), MakeString(ShortEnumName(StaticEnum<ESlateBrushTileType::Type>(), Brush.GetTiling())));

		const UObject* Resource = Brush.GetResourceObject();
		Out.Add(JoinPath(Path, TEXT("ResourceObject")), MakeString(Resource ? Resource->GetPathName() : FString(TEXT("None"))));
	}

	/** FSlateFontInfo expands into the fields that matter for text styling. */
	void EmitFont(const FString& Path, const FSlateFontInfo& Font, FFlatProperties& Out)
	{
		Out.Add(JoinPath(Path, TEXT("Size")), MakeNumber(Font.Size));
		Out.Add(JoinPath(Path, TEXT("TypefaceFontName")), MakeString(Font.TypefaceFontName.ToString()));
		Out.Add(JoinPath(Path, TEXT("LetterSpacing")), MakeNumber(Font.LetterSpacing));
		Out.Add(JoinPath(Path, TEXT("FontObject")), MakeString(Font.FontObject ? Font.FontObject->GetPathName() : FString(TEXT("None"))));
	}

	void EmitProperty(const FString& Path, FProperty* Property, const void* ValuePtr, const FDumpOptions& Options, int32 Depth, FFlatProperties& Out)
	{
		if (!Property || !ValuePtr)
		{
			return;
		}

		if (const FStructProperty* StructProperty = CastField<FStructProperty>(Property))
		{
			EmitStruct(Path, StructProperty->Struct, ValuePtr, Options, Depth, Out);
			return;
		}

		if (const FArrayProperty* ArrayProperty = CastField<FArrayProperty>(Property))
		{
			const FScriptArray* Array = static_cast<const FScriptArray*>(ValuePtr);
			const int32 Count = Array->Num();
			const int32 Stride = ArrayProperty->Inner ? ArrayProperty->Inner->GetSize() : 0;
			if (Stride <= 0)
			{
				Out.Add(Path, MakeArray({}));
				return;
			}

			const uint8* Data = static_cast<const uint8*>(Array->GetData());
			TArray<TSharedPtr<FJsonValue>> Items;
			Items.Reserve(Count);
			for (int32 Index = 0; Index < Count; ++Index)
			{
				Items.Add(ScalarValue(ArrayProperty->Inner, Data + Index * Stride));
			}
			Out.Add(Path, MakeArray(Items));
			return;
		}

		// Delegates / maps / sets / interfaces / weak pointers are not part of the style contract.
		if (CastField<FDelegateProperty>(Property) || CastField<FMulticastDelegateProperty>(Property)
			|| CastField<FInterfaceProperty>(Property) || CastField<FMapProperty>(Property)
			|| CastField<FSetProperty>(Property) || CastField<FWeakObjectProperty>(Property)
			|| CastField<FLazyObjectProperty>(Property))
		{
			return;
		}

		Out.Add(Path, ScalarValue(Property, ValuePtr));
	}

	void EmitStruct(const FString& Path, const UScriptStruct* Struct, const void* ValuePtr, const FDumpOptions& Options, int32 Depth, FFlatProperties& Out)
	{
		if (!Struct || !ValuePtr)
		{
			return;
		}

		// Slate/UMG value types get their natural JSON shape instead of being exploded.
		if (Struct == TBaseStructure<FLinearColor>::Get())
		{
			Out.Add(Path, MakeColorArray(*static_cast<const FLinearColor*>(ValuePtr)));
			return;
		}

		if (Struct == TBaseStructure<FSlateColor>::Get())
		{
			Out.Add(Path, MakeColorArray(static_cast<const FSlateColor*>(ValuePtr)->GetSpecifiedColor()));
			return;
		}

		if (Struct == TBaseStructure<FVector2D>::Get())
		{
			Out.Add(Path, MakeVector2Array(*static_cast<const FVector2D*>(ValuePtr)));
			return;
		}

		if (Struct == TBaseStructure<FIntPoint>::Get())
		{
			const FIntPoint* Point = static_cast<const FIntPoint*>(ValuePtr);
			Out.Add(Path, MakeVector2Array(FVector2D(Point->X, Point->Y)));
			return;
		}

		if (Struct == TBaseStructure<FVector>::Get())
		{
			const FVector* Vector = static_cast<const FVector*>(ValuePtr);
			Out.Add(Path, MakeVector2Array(FVector2D(Vector->X, Vector->Y)));
			Out.Add(JoinPath(Path, TEXT("Z")), MakeNumber(Vector->Z));
			return;
		}

		if (Struct == TBaseStructure<FVector4>::Get())
		{
			Out.Add(Path, MakeVector4Array(*static_cast<const FVector4*>(ValuePtr)));
			return;
		}

		if (Struct == TBaseStructure<FMargin>::Get())
		{
			Out.Add(Path, MakeMarginArray(*static_cast<const FMargin*>(ValuePtr)));
			return;
		}

		if (Struct == TBaseStructure<FSlateBrush>::Get())
		{
			EmitBrush(Path, *static_cast<const FSlateBrush*>(ValuePtr), Out);
			return;
		}

		if (Struct == TBaseStructure<FSlateFontInfo>::Get())
		{
			EmitFont(Path, *static_cast<const FSlateFontInfo*>(ValuePtr), Out);
			return;
		}

		if (Depth >= Options.MaxDepth)
		{
			FString Exported;
			Struct->ExportText(Exported, ValuePtr, nullptr, nullptr, PPF_None, nullptr);
			Out.Add(Path, MakeString(Exported));
			return;
		}

		EmitStructFields(Path, Struct, ValuePtr, Options, Depth, Out);
	}

	void EmitStructFields(const FString& Path, const UScriptStruct* Struct, const void* ValuePtr, const FDumpOptions& Options, int32 Depth, FFlatProperties& Out)
	{
		for (TFieldIterator<FProperty> It(Struct); It; ++It)
		{
			FProperty* Property = *It;
			if (!Property || Property->HasAnyPropertyFlags(CPF_Deprecated))
			{
				continue;
			}

			if (!Options.bDeep && !Property->HasAnyPropertyFlags(CPF_Edit | CPF_BlueprintVisible))
			{
				continue;
			}

			const FString ChildPath = JoinPath(Path, Property->GetName());
			EmitProperty(ChildPath, Property, Property->ContainerPtrToValuePtr<void>(ValuePtr), Options, Depth + 1, Out);
		}
	}

	void FlattenObject(UObject* Object, const FDumpOptions& Options, FFlatProperties& Out)
	{
		if (!Object)
		{
			return;
		}

		UClass* Class = Object->GetClass();
		for (TFieldIterator<FProperty> It(Class); It; ++It)
		{
			FProperty* Property = *It;
			if (!Property || Property->HasAnyPropertyFlags(CPF_Deprecated | CPF_Transient))
			{
				continue;
			}

			// Default: exactly what the importer can write (editable/blueprint-visible UPROPERTYs).
			if (!Options.bDeep && !Property->HasAnyPropertyFlags(CPF_Edit | CPF_BlueprintVisible))
			{
				continue;
			}

			if (Property->HasAnyPropertyFlags(CPF_EditorOnly) && !Options.bDeep)
			{
				continue;
			}

			EmitProperty(Property->GetName(), Property, Property->ContainerPtrToValuePtr<void>(Object), Options, 0, Out);
		}
	}

	// ---------------------------------------------------------------- tree walk

	void WalkWidgets(UWidget* Widget, UWidget* Parent, const FDumpOptions& Options, TArray<TSharedPtr<FJsonValue>>& OutWidgets, int32 Depth)
	{
		if (!Widget || Depth > 128)
		{
			return;
		}

		TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("class"), Widget->GetClass()->GetName());
		Entry->SetStringField(TEXT("name"), Widget->GetName());
		Entry->SetBoolField(TEXT("variable"), Widget->bIsVariable != 0);
		if (Parent)
		{
			Entry->SetStringField(TEXT("parent"), Parent->GetName());
		}

		FFlatProperties Flat;
		FlattenObject(Widget, Options, Flat);

		TSharedPtr<FJsonObject> Properties = MakeShared<FJsonObject>();
		TArray<FString> Keys;
		Flat.GetKeys(Keys);
		Keys.Sort();
		for (const FString& Key : Keys)
		{
			Properties->SetField(Key, Flat.FindRef(Key));
		}
		Entry->SetObjectField(TEXT("properties"), Properties);
		OutWidgets.Add(MakeShared<FJsonValueObject>(Entry));

		if (UPanelWidget* Panel = Cast<UPanelWidget>(Widget))
		{
			const int32 ChildCount = Panel->GetChildrenCount();
			for (int32 Index = 0; Index < ChildCount; ++Index)
			{
				WalkWidgets(Panel->GetChildAt(Index), Widget, Options, OutWidgets, Depth + 1);
			}
		}
	}

	// ---------------------------------------------------------------- console output

	/** Console noise filter: these rarely help when eyeballing style values (they stay in the JSON). */
	bool IsConsoleNoise(const FString& Path)
	{
		static const TCHAR* NoisyPrefixes[] =
		{
			TEXT("RenderTransform"),
			TEXT("Navigation"),
			TEXT("ToolTip"),
			TEXT("Cursor"),
			TEXT("Accessible"),
			TEXT("ShapedTextOptions"),
			TEXT("Clipping"),
			TEXT("FlowDirection"),
			TEXT("bIsFocusable"),
			TEXT("bHasScriptImplementedTick"),
		};

		for (const TCHAR* Prefix : NoisyPrefixes)
		{
			if (Path.StartsWith(Prefix, ESearchCase::IgnoreCase))
			{
				return true;
			}
		}
		return false;
	}

	void DumpWidgetsCommand(const TArray<FString>& Args)
	{
		if (Args.Num() < 1)
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Usage: Html2UMG.DumpWidgets <blueprintPath> [--deep] [--json=<out.json>]"));
			return;
		}

		FDumpOptions Options;
		FString BlueprintPath = Args[0];
		FString JsonFile;

		for (int32 Index = 1; Index < Args.Num(); ++Index)
		{
			if (Args[Index].Equals(TEXT("--deep"), ESearchCase::IgnoreCase))
			{
				Options.bDeep = true;
			}
			else if (Args[Index].StartsWith(TEXT("--json="), ESearchCase::IgnoreCase))
			{
				JsonFile = Args[Index].RightChop(7);
				JsonFile.ReplaceInline(TEXT("\""), TEXT(""));
				JsonFile.TrimStartAndEndInline();
			}
		}

		BlueprintPath.ReplaceInline(TEXT("\\"), TEXT("/"));
		BlueprintPath.ReplaceInline(TEXT("\""), TEXT(""));
		while (BlueprintPath.EndsWith(TEXT(",")) || BlueprintPath.EndsWith(TEXT(";")))
		{
			BlueprintPath.LeftChopInline(1);
		}

		const FString AssetName = FPackageName::GetShortName(BlueprintPath);
		const FString ObjectPath = BlueprintPath.Contains(TEXT("."))
			? BlueprintPath
			: FString::Printf(TEXT("%s.%s"), *BlueprintPath, *AssetName);

		UWidgetBlueprint* Blueprint = LoadObject<UWidgetBlueprint>(nullptr, *ObjectPath);
		if (!Blueprint)
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.DumpWidgets: '%s' is not a loadable Widget Blueprint."), *BlueprintPath);
			return;
		}

		if (!Blueprint->WidgetTree || !Blueprint->WidgetTree->RootWidget)
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.DumpWidgets: '%s' has an empty widget tree."), *BlueprintPath);
			return;
		}

		TArray<TSharedPtr<FJsonValue>> Widgets;
		WalkWidgets(Blueprint->WidgetTree->RootWidget, nullptr, Options, Widgets, 0);

		// ---- console: class/name/variable + flat key/value pairs ----
		UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.DumpWidgets: %s -> %d widget(s)"), *BlueprintPath, Widgets.Num());
		int32 Index = 0;
		for (const TSharedPtr<FJsonValue>& WidgetValue : Widgets)
		{
			const TSharedPtr<FJsonObject> Entry = WidgetValue->AsObject();
			if (!Entry.IsValid())
			{
				continue;
			}

			FString ClassName;
			FString WidgetName;
			bool bVariable = false;
			Entry->TryGetStringField(TEXT("class"), ClassName);
			Entry->TryGetStringField(TEXT("name"), WidgetName);
			Entry->TryGetBoolField(TEXT("variable"), bVariable);

			FString ParentName;
			Entry->TryGetStringField(TEXT("parent"), ParentName);

			UE_LOG(LogHtml2UMG, Display, TEXT("[%03d] %s '%s'%s%s"), Index++,
				*ClassName, *WidgetName,
				bVariable ? TEXT(" (variable)") : TEXT(""),
				ParentName.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(" parent=%s"), *ParentName));

			const TSharedPtr<FJsonObject>* Properties = nullptr;
			if (Entry->TryGetObjectField(TEXT("properties"), Properties) && Properties && (*Properties).IsValid())
			{
				// The values map is keyed by UE::FSharedString in 5.8, so collect (name, value) pairs.
				TArray<TPair<FString, TSharedPtr<FJsonValue>>> Sorted;
				Sorted.Reserve((*Properties)->Values.Num());
				for (const auto& Pair : (*Properties)->Values)
				{
					Sorted.Emplace(FString(*Pair.Key), Pair.Value);
				}
				Sorted.Sort([](const TPair<FString, TSharedPtr<FJsonValue>>& A, const TPair<FString, TSharedPtr<FJsonValue>>& B)
				{
					return A.Key < B.Key;
				});

				for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Sorted)
				{
					if (IsConsoleNoise(Pair.Key))
					{
						continue;
					}

					FString Rendered;
					const TSharedPtr<FJsonValue> Value = Pair.Value;
					if (Value.IsValid())
					{
						if (Value->Type == EJson::String)
						{
							Rendered = FString::Printf(TEXT("\"%s\""), *Value->AsString());
						}
						else
						{
							FString Serialized;
							const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialized);
							FJsonSerializer::Serialize(Value.ToSharedRef(), TEXT(""), Writer);
							Rendered = Serialized;
						}
					}
					UE_LOG(LogHtml2UMG, Display, TEXT("      %s = %s"), *Pair.Key, *Rendered);
				}
			}
		}

		// ---- json: the audit contract ----
		if (JsonFile.IsEmpty())
		{
			return;
		}

		TSharedPtr<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetStringField(TEXT("blueprint"), BlueprintPath);
		Root->SetArrayField(TEXT("widgets"), Widgets);

		FString Output;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		if (!FJsonSerializer::Serialize(Root.ToSharedRef(), Writer))
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.DumpWidgets: failed to serialise JSON."));
			return;
		}

		if (!FFileHelper::SaveStringToFile(Output, *JsonFile))
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.DumpWidgets: could not write '%s'."), *JsonFile);
			return;
		}

		UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.DumpWidgets: wrote %s (%d widgets, %d bytes)"),
			*JsonFile, Widgets.Num(), Output.Len());
	}
}

static FAutoConsoleCommand GDumpWidgetsCommand(
	TEXT("Html2UMG.DumpWidgets"),
	TEXT("Dumps the widget tree of a Widget Blueprint with every editable UPROPERTY as a flat dotted path. "
		"Usage: Html2UMG.DumpWidgets <blueprintPath> [--deep] [--json=<out.json>]"),
	FConsoleCommandWithArgsDelegate::CreateStatic(&DumpWidgetsCommand));
