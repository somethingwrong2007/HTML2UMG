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

// Layout export: slot types, texture readback and font faces.
#include "Components/CanvasPanelSlot.h"
#include "Components/GridSlot.h"
#include "Components/HorizontalBoxSlot.h"
#include "Components/UniformGridSlot.h"
#include "Components/VerticalBoxSlot.h"
#include "Components/WrapBoxSlot.h"
#include "Engine/Font.h"
#include "Engine/FontFace.h"
#include "Engine/Texture2D.h"
#include "Fonts/CompositeFont.h"
#include "HAL/FileManager.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Modules/ModuleManager.h"

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

	// ---------------------------------------------------------------- layout export (WBP -> contract json)
	//
	// The import pipeline is HTML -> layout.json -> WidgetBlueprint. This is the other direction:
	// WidgetBlueprint -> layout.json in the SAME shape the importer consumes (nested tree, slot
	// objects, flat dotted properties), so a Node side can render it back to HTML.
	//
	// Slot data is the part DumpWidgets never had: it flattens the tree and drops UPanelSlot, which is
	// exactly what a layout export needs most (Anchors/Offsets on a canvas, Size/Padding in a box).

	struct FExportContext
	{
		FString AssetsDir;					// absolute; empty => no binaries written
		FString AssetsRel = TEXT("assets");
		TMap<const UObject*, FString> Keys;
		TArray<TSharedPtr<FJsonValue>> Textures;
		TArray<TSharedPtr<FJsonValue>> Fonts;
		int32 NextKey = 0;
	};

	const TCHAR* AlignNameH(EHorizontalAlignment Value)
	{
		switch (Value)
		{
		case HAlign_Fill: return TEXT("Fill");
		case HAlign_Left: return TEXT("Left");
		case HAlign_Center: return TEXT("Center");
		case HAlign_Right: return TEXT("Right");
		default: return TEXT("Fill");
		}
	}

	const TCHAR* AlignNameV(EVerticalAlignment Value)
	{
		switch (Value)
		{
		case VAlign_Fill: return TEXT("Fill");
		case VAlign_Top: return TEXT("Top");
		case VAlign_Center: return TEXT("Center");
		case VAlign_Bottom: return TEXT("Bottom");
		default: return TEXT("Fill");
		}
	}

	TSharedPtr<FJsonObject> LayoutDataJson(const FAnchorData& Layout)
	{
		TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
		TSharedPtr<FJsonObject> Anchors = MakeShared<FJsonObject>();
		Anchors->SetArrayField(TEXT("Minimum"), { MakeNumber(Layout.Anchors.Minimum.X), MakeNumber(Layout.Anchors.Minimum.Y) });
		Anchors->SetArrayField(TEXT("Maximum"), { MakeNumber(Layout.Anchors.Maximum.X), MakeNumber(Layout.Anchors.Maximum.Y) });
		TSharedPtr<FJsonObject> Offsets = MakeShared<FJsonObject>();
		Offsets->SetField(TEXT("Left"), MakeNumber(Layout.Offsets.Left));
		Offsets->SetField(TEXT("Top"), MakeNumber(Layout.Offsets.Top));
		Offsets->SetField(TEXT("Right"), MakeNumber(Layout.Offsets.Right));
		Offsets->SetField(TEXT("Bottom"), MakeNumber(Layout.Offsets.Bottom));
		Out->SetObjectField(TEXT("Anchors"), Anchors);
		Out->SetObjectField(TEXT("Offsets"), Offsets);
		Out->SetArrayField(TEXT("Alignment"), { MakeNumber(Layout.Alignment.X), MakeNumber(Layout.Alignment.Y) });
		return Out;
	}

	/** Nested slot object in the shape the importer reads back. */
	TSharedPtr<FJsonObject> EmitSlot(UWidget* Widget)
	{
		UPanelSlot* Slot = Widget ? Widget->Slot : nullptr;
		if (!Slot)
		{
			return nullptr;
		}

		TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();

		if (const UCanvasPanelSlot* CanvasSlot = Cast<UCanvasPanelSlot>(Slot))
		{
			Out->SetObjectField(TEXT("LayoutData"), LayoutDataJson(CanvasSlot->GetLayout()));
			Out->SetBoolField(TEXT("bAutoSize"), CanvasSlot->GetAutoSize());
			Out->SetField(TEXT("ZOrder"), MakeNumber(CanvasSlot->GetZOrder()));
			return Out;
		}

		if (const UWrapBoxSlot* WrapSlot = Cast<UWrapBoxSlot>(Slot))
		{
			Out->SetArrayField(TEXT("Padding"), { MakeNumber(WrapSlot->GetPadding().Left), MakeNumber(WrapSlot->GetPadding().Top), MakeNumber(WrapSlot->GetPadding().Right), MakeNumber(WrapSlot->GetPadding().Bottom) });
			Out->SetStringField(TEXT("HorizontalAlignment"), AlignNameH(WrapSlot->GetHorizontalAlignment()));
			Out->SetStringField(TEXT("VerticalAlignment"), AlignNameV(WrapSlot->GetVerticalAlignment()));
			Out->SetField(TEXT("FillSpanWhenLessThan"), MakeNumber(WrapSlot->GetFillSpanWhenLessThan()));
			Out->SetBoolField(TEXT("bForceNewLine"), WrapSlot->DoesForceNewLine());
			return Out;
		}

		if (const UGridSlot* GridSlot = Cast<UGridSlot>(Slot))
		{
			Out->SetArrayField(TEXT("Padding"), { MakeNumber(GridSlot->GetPadding().Left), MakeNumber(GridSlot->GetPadding().Top), MakeNumber(GridSlot->GetPadding().Right), MakeNumber(GridSlot->GetPadding().Bottom) });
			Out->SetField(TEXT("Row"), MakeNumber(GridSlot->GetRow()));
			Out->SetField(TEXT("Column"), MakeNumber(GridSlot->GetColumn()));
			Out->SetField(TEXT("RowSpan"), MakeNumber(GridSlot->GetRowSpan()));
			Out->SetField(TEXT("ColumnSpan"), MakeNumber(GridSlot->GetColumnSpan()));
			Out->SetField(TEXT("Layer"), MakeNumber(GridSlot->GetLayer()));
			Out->SetStringField(TEXT("HorizontalAlignment"), AlignNameH(GridSlot->GetHorizontalAlignment()));
			Out->SetStringField(TEXT("VerticalAlignment"), AlignNameV(GridSlot->GetVerticalAlignment()));
			return Out;
		}

		if (const UUniformGridSlot* UniformSlot = Cast<UUniformGridSlot>(Slot))
		{
			Out->SetField(TEXT("Row"), MakeNumber(UniformSlot->GetRow()));
			Out->SetField(TEXT("Column"), MakeNumber(UniformSlot->GetColumn()));
			Out->SetStringField(TEXT("HorizontalAlignment"), AlignNameH(UniformSlot->GetHorizontalAlignment()));
			Out->SetStringField(TEXT("VerticalAlignment"), AlignNameV(UniformSlot->GetVerticalAlignment()));
			return Out;
		}

		// Box panels carry a Size rule (Fill weight) on top of the alignment pair.
		if (const UVerticalBoxSlot* VSlot = Cast<UVerticalBoxSlot>(Slot))
		{
			Out->SetArrayField(TEXT("Padding"), { MakeNumber(VSlot->GetPadding().Left), MakeNumber(VSlot->GetPadding().Top), MakeNumber(VSlot->GetPadding().Right), MakeNumber(VSlot->GetPadding().Bottom) });
			TSharedPtr<FJsonObject> Size = MakeShared<FJsonObject>();
			Size->SetStringField(TEXT("SizeRule"), VSlot->GetSize().SizeRule == ESlateSizeRule::Automatic ? TEXT("Automatic") : TEXT("Fill"));
			Size->SetField(TEXT("Value"), MakeNumber(VSlot->GetSize().Value));
			Out->SetObjectField(TEXT("Size"), Size);
			Out->SetStringField(TEXT("HorizontalAlignment"), AlignNameH(VSlot->GetHorizontalAlignment()));
			Out->SetStringField(TEXT("VerticalAlignment"), AlignNameV(VSlot->GetVerticalAlignment()));
			return Out;
		}

		if (const UHorizontalBoxSlot* HSlot = Cast<UHorizontalBoxSlot>(Slot))
		{
			Out->SetArrayField(TEXT("Padding"), { MakeNumber(HSlot->GetPadding().Left), MakeNumber(HSlot->GetPadding().Top), MakeNumber(HSlot->GetPadding().Right), MakeNumber(HSlot->GetPadding().Bottom) });
			TSharedPtr<FJsonObject> Size = MakeShared<FJsonObject>();
			Size->SetStringField(TEXT("SizeRule"), HSlot->GetSize().SizeRule == ESlateSizeRule::Automatic ? TEXT("Automatic") : TEXT("Fill"));
			Size->SetField(TEXT("Value"), MakeNumber(HSlot->GetSize().Value));
			Out->SetObjectField(TEXT("Size"), Size);
			Out->SetStringField(TEXT("HorizontalAlignment"), AlignNameH(HSlot->GetHorizontalAlignment()));
			Out->SetStringField(TEXT("VerticalAlignment"), AlignNameV(HSlot->GetVerticalAlignment()));
			return Out;
		}

		// Single-child hosts (Overlay/Border/SizeBox/Button/ScrollBox/BackgroundBlur/NamedSlot).
		if (const UPanelSlot* PanelSlot = Slot)
		{
			const FString SlotClass = PanelSlot->GetClass()->GetName();
			TSharedPtr<FJsonObject> Props = MakeShared<FJsonObject>();
			FDumpOptions Deep;
			Deep.bDeep = false;
			FFlatProperties Flat;
			FlattenObject(const_cast<UPanelSlot*>(PanelSlot), Deep, Flat);
			if (Flat.Num() > 0)
			{
				TArray<FString> Keys;
				Flat.GetKeys(Keys);
				Keys.Sort();
				for (const FString& Key : Keys)
				{
					Props->SetField(Key, Flat.FindRef(Key));
				}
				// Flattened struct fields ("Padding.Left") are not what the importer reads; collapse the
				// ones a layout needs into the contract's array shape.
				// FlattenObject already collapses FMargin into an array under "Padding"; the
				// dotted Padding.Left form is handled too in case that special case changes.
				TSharedPtr<FJsonValue> Pad = Props->HasField(TEXT("Padding")) ? Props->TryGetField(TEXT("Padding")) : nullptr;
				if (!Pad.IsValid() && Props->HasField(TEXT("Padding.Left")))
				{
					TArray<TSharedPtr<FJsonValue>> Sides;
					for (const TCHAR* Side : { TEXT("Padding.Left"), TEXT("Padding.Top"), TEXT("Padding.Right"), TEXT("Padding.Bottom") })
					{
						Sides.Add(Props->HasField(Side) ? Props->TryGetField(Side) : MakeNumber(0));
						Props->RemoveField(Side);
					}
					Pad = MakeArray(Sides);
				}
				if (Pad.IsValid()) Props->RemoveField(TEXT("Padding"));
				// The alignment pair and Padding are promoted to the TOP level, and the alignment is
				// spelled the same way the box/canvas slots spell it. Leaving them inside a nested
				// "properties" object with enum-prefixed values ("HAlign_Fill") meant one contract had
				// two slot dialects, and a consumer had to know which host it came from.
				for (const TCHAR* Align : { TEXT("HorizontalAlignment"), TEXT("VerticalAlignment") })
				{
					if (!Props->HasField(Align)) continue;
					FString Value = Props->GetStringField(Align);
					int32 Separator = INDEX_NONE;
					if (Value.FindLastChar(TEXT('_'), Separator) && (Value.StartsWith(TEXT("HAlign_")) || Value.StartsWith(TEXT("VAlign_"))))
					{
						Value = Value.RightChop(Separator + 1);
					}
					Props->RemoveField(Align);
					Out->SetStringField(Align, Value);
				}
				if (Pad.IsValid())
				{
					Out->SetField(TEXT("Padding"), Pad);
				}
			}
			if (Props->Values.Num() > 0)
			{
				Out->SetObjectField(TEXT("properties"), Props);
			}
			Out->SetStringField(TEXT("slotClass"), SlotClass);
			return Out;
		}

		return nullptr;
	}

	bool ExportTexturePng(UTexture2D* Texture, const FString& FilePath, FString& OutError)
	{
	#if WITH_EDITORONLY_DATA
		if (!Texture || !Texture->Source.IsValid())
		{
			OutError = TEXT("has no texture source");
			return false;
		}

		const int32 Width = Texture->Source.GetSizeX();
		const int32 Height = Texture->Source.GetSizeY();
		const ETextureSourceFormat Format = Texture->Source.GetFormat();
		const uint8* Pixels = Texture->Source.LockMipReadOnly(0);
		if (Width <= 0 || Height <= 0 || Pixels == nullptr)
		{
			OutError = TEXT("has empty pixels");
			return false;
		}

		const int64 Count = static_cast<int64>(Width) * Height;
		TArray<uint8> Rgba;
		Rgba.SetNumUninitialized(Count * 4);
		for (int64 Index = 0; Index < Count; ++Index)
		{
			uint8 R = 0, G = 0, B = 0, A = 255;
			switch (Format)
			{
			case TSF_BGRA8:
				B = Pixels[Index * 4 + 0]; G = Pixels[Index * 4 + 1]; R = Pixels[Index * 4 + 2]; A = Pixels[Index * 4 + 3];
				break;
			case TSF_G8:
				R = G = B = Pixels[Index]; A = 255;
				break;
			case TSF_RGBA16:
				// 16 bit per channel: take the high byte of each channel.
				{
					const uint8* Src = Pixels + Index * 8;
					R = Src[0]; G = Src[2]; B = Src[4]; A = Src[6];
				}
				break;
			default:
				OutError = FString::Printf(TEXT("has unsupported source format %d"), static_cast<int32>(Format));
				return false;
			}
			Rgba[Index * 4 + 0] = R;
			Rgba[Index * 4 + 1] = G;
			Rgba[Index * 4 + 2] = B;
			Rgba[Index * 4 + 3] = A;
		}

		IImageWrapperModule& Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
		const TSharedPtr<IImageWrapper> Wrapper = Module.CreateImageWrapper(EImageFormat::PNG);
		if (!Wrapper.IsValid() || !Wrapper->SetRaw(Rgba.GetData(), Rgba.Num(), Width, Height, ERGBFormat::RGBA, 8))
		{
			OutError = TEXT("could not encode png");
			return false;
		}
		const TArray64<uint8>& Compressed = Wrapper->GetCompressed();
		if (!FFileHelper::SaveArrayToFile(Compressed, *FilePath))
		{
			OutError = FString::Printf(TEXT("could not write %s"), *FilePath);
			return false;
		}
		return true;
	#else
		OutError = TEXT("editor-only");
		return false;
	#endif
	}

	/** Registers a texture reference, exporting the png the first time it is seen. */
	void NoteTexture(const FString& ObjectPath, FExportContext& Context)
	{
		UTexture2D* Texture = FindObject<UTexture2D>(nullptr, *ObjectPath);
		if (!Texture)
		{
			Texture = LoadObject<UTexture2D>(nullptr, *ObjectPath);
		}
		if (!Texture)
		{
			return;
		}
		if (Context.Keys.Contains(Texture))
		{
			return;
		}

		const FString Key = FString::Printf(TEXT("tex_%d"), Context.NextKey++);
		Context.Keys.Add(Texture, Key);

		FString Relative;
		if (!Context.AssetsDir.IsEmpty())
		{
			const FString File = FString::Printf(TEXT("%s.png"), *Key);
			const FString Absolute = FPaths::Combine(Context.AssetsDir, File);
			FString Error;
			if (ExportTexturePng(Texture, Absolute, Error))
			{
				Relative = FString::Printf(TEXT("%s/%s"), *Context.AssetsRel, *File);
			}
			else
			{
				UE_LOG(LogHtml2UMG, Warning, TEXT("Html2UMG.ExportLayout: texture %s %s"), *Texture->GetPathName(), *Error);
			}
		}

		TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("key"), Key);
		Entry->SetStringField(TEXT("source"), Texture->GetPathName());
		if (!Relative.IsEmpty())
		{
			Entry->SetStringField(TEXT("file"), Relative);
		}
		Entry->SetField(TEXT("width"), MakeNumber(Texture->GetSurfaceWidth()));
		Entry->SetField(TEXT("height"), MakeNumber(Texture->GetSurfaceHeight()));
		Context.Textures.Add(MakeShared<FJsonValueObject>(Entry));
	}

	/** Registers a font reference; copies a source ttf next to the html when one is still on disk. */
	void NoteFont(const FString& ObjectPath, FExportContext& Context)
	{
		UFont* Font = FindObject<UFont>(nullptr, *ObjectPath);
		if (!Font)
		{
			Font = LoadObject<UFont>(nullptr, *ObjectPath);
		}
		if (!Font || Context.Keys.Contains(Font))
		{
			return;
		}

		const FString Key = FString::Printf(TEXT("font_%d"), Context.NextKey++);
		Context.Keys.Add(Font, Key);

		TArray<FString> Typefaces;
		FString SourceFile;
	#if WITH_EDITORONLY_DATA
		for (const FTypefaceEntry& Entry : Font->CompositeFont.DefaultTypeface.Fonts)
		{
			Typefaces.Add(Entry.Name.ToString());
			if (SourceFile.IsEmpty())
			{
				if (const UFontFace* Face = Cast<UFontFace>(Entry.Font.GetFontFaceAsset()))
				{
					if (!Face->SourceFilename.IsEmpty() && FPaths::FileExists(Face->SourceFilename))
					{
						SourceFile = Face->SourceFilename;
					}
				}
			}
		}
	#endif

		FString Relative;
		if (!SourceFile.IsEmpty() && !Context.AssetsDir.IsEmpty())
		{
			const FString File = FString::Printf(TEXT("%s%s"), *Key, *FPaths::GetExtension(SourceFile, true));
			const FString Absolute = FPaths::Combine(Context.AssetsDir, File);
			if (IFileManager::Get().Copy(*Absolute, *SourceFile, true, true) == COPY_OK)
			{
				Relative = FString::Printf(TEXT("%s/%s"), *Context.AssetsRel, *File);
			}
		}

		TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("key"), Key);
		Entry->SetStringField(TEXT("source"), Font->GetPathName());
		Entry->SetStringField(TEXT("family"), Font->GetName());
		if (!Relative.IsEmpty())
		{
			Entry->SetStringField(TEXT("file"), Relative);
		}
		TArray<TSharedPtr<FJsonValue>> Faces;
		for (const FString& Typeface : Typefaces)
		{
			Faces.Add(MakeString(Typeface));
		}
		Entry->SetArrayField(TEXT("typefaces"), Faces);
		Context.Fonts.Add(MakeShared<FJsonValueObject>(Entry));
	}

	TSharedPtr<FJsonObject> BuildLayoutNode(UWidget* Widget, FExportContext& Context, const FDumpOptions& Options, int32 Depth)
	{
		if (!Widget || Depth > 128)
		{
			return nullptr;
		}

		TSharedPtr<FJsonObject> Node = MakeShared<FJsonObject>();
		Node->SetStringField(TEXT("class"), Widget->GetClass()->GetName());
		Node->SetStringField(TEXT("name"), Widget->GetName());
		if (!Widget->bIsVariable)
		{
			Node->SetBoolField(TEXT("variable"), false);
		}

		if (TSharedPtr<FJsonObject> Slot = EmitSlot(Widget))
		{
			Node->SetObjectField(TEXT("slot"), Slot);
		}

		FFlatProperties Flat;
		FlattenObject(Widget, Options, Flat);
		TSharedPtr<FJsonObject> Properties = MakeShared<FJsonObject>();
		TArray<FString> Keys;
		Flat.GetKeys(Keys);
		Keys.Sort();
		for (const FString& Key : Keys)
		{
			const TSharedPtr<FJsonValue> Value = Flat.FindRef(Key);
			Properties->SetField(Key, Value);
			// Object references become assets: textures get a png, fonts get a ttf when one exists.
			if (Value.IsValid() && Value->Type == EJson::String)
			{
				const FString Text = Value->AsString();
				if (Text.StartsWith(TEXT("/Game/")) || Text.StartsWith(TEXT("/Engine/")))
				{
					// Ask the object what it IS rather than guessing from the path. The old heuristic
					// looked for "Texture2D" or "/T_" in the name and missed every content-addressed
					// texture ("tex_input_track_fb250cd6"), so an Image exported with no png at all and
					// its element came back blank.
					if (UTexture2D* Loaded = LoadObject<UTexture2D>(nullptr, *Text))
					{
						NoteTexture(Loaded->GetPathName(), Context);
					}
					else if (UFont* LoadedFont = LoadObject<UFont>(nullptr, *Text))
					{
						NoteFont(LoadedFont->GetPathName(), Context);
					}
				}
			}
		}
		Node->SetObjectField(TEXT("properties"), Properties);

		if (const UPanelWidget* Panel = Cast<UPanelWidget>(Widget))
		{
			TArray<TSharedPtr<FJsonValue>> Children;
			for (int32 Index = 0; Index < Panel->GetChildrenCount(); ++Index)
			{
				if (TSharedPtr<FJsonObject> Child = BuildLayoutNode(Panel->GetChildAt(Index), Context, Options, Depth + 1))
				{
					Children.Add(MakeShared<FJsonValueObject>(Child));
				}
			}
			if (Children.Num() > 0)
			{
				Node->SetArrayField(TEXT("children"), Children);
			}
		}

		return Node;
	}

	void ExportLayoutCommand(const TArray<FString>& Args)
	{
		if (Args.Num() < 1)
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Usage: Html2UMG.ExportLayout <blueprintPath> --json=<out.json> [--assets=<dir>] [--viewport=1920x1080]"));
			return;
		}

		FString BlueprintPath = Args[0];
		FString JsonFile;
		FString AssetsDir;
		FIntPoint Viewport(1920, 1080);

		for (int32 Index = 1; Index < Args.Num(); ++Index)
		{
			const FString& Arg = Args[Index];
			FString Value;
			if (Arg.StartsWith(TEXT("--json="))) { Value = Arg.RightChop(7); JsonFile = Value; }
			else if (Arg.StartsWith(TEXT("--assets="))) { AssetsDir = Arg.RightChop(9); }
			else if (Arg.StartsWith(TEXT("--viewport=")))
			{
				FString Size = Arg.RightChop(11);
				FString W, H;
				if (Size.Split(TEXT("x"), &W, &H))
				{
					Viewport = FIntPoint(FCString::Atoi(*W), FCString::Atoi(*H));
				}
			}
		}

		BlueprintPath.ReplaceInline(TEXT("\\"), TEXT("/"));
		BlueprintPath.ReplaceInline(TEXT("\""), TEXT(""));
		JsonFile.ReplaceInline(TEXT("\""), TEXT(""));
		AssetsDir.ReplaceInline(TEXT("\""), TEXT(""));
		while (BlueprintPath.EndsWith(TEXT(",")) || BlueprintPath.EndsWith(TEXT(";")))
		{
			BlueprintPath.LeftChopInline(1);
		}

		const FString AssetName = FPackageName::GetShortName(BlueprintPath);
		const FString ObjectPath = BlueprintPath.Contains(TEXT(".")) ? BlueprintPath : FString::Printf(TEXT("%s.%s"), *BlueprintPath, *AssetName);
		UWidgetBlueprint* Blueprint = LoadObject<UWidgetBlueprint>(nullptr, *ObjectPath);
		if (!Blueprint || !Blueprint->WidgetTree || !Blueprint->WidgetTree->RootWidget)
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.ExportLayout: '%s' is not a loadable widget blueprint with a root."), *BlueprintPath);
			return;
		}

		FExportContext Context;
		if (!AssetsDir.IsEmpty())
		{
			Context.AssetsDir = FPaths::ConvertRelativePathToFull(AssetsDir);
			IFileManager::Get().MakeDirectory(*Context.AssetsDir, true);
			// The JSON has to say where its own assets are, RELATIVE TO ITSELF: the asset paths are
			// what a consumer (the HTML writer, an audit tool) resolves, and both the exporter and a
			// person pick any directory for --assets. A hardcoded "assets/" silently pointed at the
			// wrong place as soon as it was not literally a subdirectory called assets.
			if (!JsonFile.IsEmpty())
			{
				FString Relative = Context.AssetsDir;
				FPaths::MakePathRelativeTo(Relative, *(FPaths::GetPath(FPaths::ConvertRelativePathToFull(JsonFile)) + TEXT("/")));
				Relative.ReplaceInline(TEXT("\\"), TEXT("/"));
				if (!Relative.IsEmpty()) Context.AssetsRel = Relative;
			}
		}

		FDumpOptions Options;
		TSharedPtr<FJsonObject> RootNode = BuildLayoutNode(Blueprint->WidgetTree->RootWidget, Context, Options, 0);

		TSharedPtr<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetField(TEXT("contractVersion"), MakeNumber(1));
		Root->SetStringField(TEXT("blueprint"), Blueprint->GetPathName());
		TSharedPtr<FJsonObject> ViewportJson = MakeShared<FJsonObject>();
		ViewportJson->SetField(TEXT("width"), MakeNumber(Viewport.X));
		ViewportJson->SetField(TEXT("height"), MakeNumber(Viewport.Y));
		Root->SetObjectField(TEXT("viewport"), ViewportJson);

		TSharedPtr<FJsonObject> Assets = MakeShared<FJsonObject>();
		Assets->SetArrayField(TEXT("textures"), Context.Textures);
		Assets->SetArrayField(TEXT("fonts"), Context.Fonts);
		Root->SetObjectField(TEXT("assets"), Assets);

		TSharedPtr<FJsonObject> Settings = MakeShared<FJsonObject>();
		Settings->SetStringField(TEXT("exportedFrom"), Blueprint->GetPathName());
		Settings->SetStringField(TEXT("exporter"), TEXT("Html2UMG.ExportLayout"));
		Root->SetObjectField(TEXT("settings"), Settings);
		Root->SetObjectField(TEXT("root"), RootNode);

		FString Output;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		if (!FJsonSerializer::Serialize(Root.ToSharedRef(), Writer))
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.ExportLayout: failed to serialise JSON."));
			return;
		}

		if (JsonFile.IsEmpty())
		{
			UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.ExportLayout: %s"), *Output);
			return;
		}
		// Force UTF-8: every consumer of this file is a Node/Python tool, and a UTF-16 BOM turns
		// JSON.parse into an error that looks like a corrupt export.
		if (!FFileHelper::SaveStringToFile(Output, *JsonFile, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.ExportLayout: could not write '%s'."), *JsonFile);
			return;
		}

		UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.ExportLayout: wrote %s (%d texture(s), %d font(s), %d bytes)"),
			*JsonFile, Context.Textures.Num(), Context.Fonts.Num(), Output.Len());
	}
}

static FAutoConsoleCommand GExportLayoutCommand(
	TEXT("Html2UMG.ExportLayout"),
	TEXT("Exports a Widget Blueprint as the layout contract JSON (nested tree, slots, properties) plus its textures as png. "
		"Usage: Html2UMG.ExportLayout <blueprintPath> --json=<out.json> [--assets=<dir>] [--viewport=1920x1080]"),
	FConsoleCommandWithArgsDelegate::CreateStatic(&ExportLayoutCommand));

static FAutoConsoleCommand GDumpWidgetsCommand(
	TEXT("Html2UMG.DumpWidgets"),
	TEXT("Dumps the widget tree of a Widget Blueprint with every editable UPROPERTY as a flat dotted path. "
		"Usage: Html2UMG.DumpWidgets <blueprintPath> [--deep] [--json=<out.json>]"),
	FConsoleCommandWithArgsDelegate::CreateStatic(&DumpWidgetsCommand));
