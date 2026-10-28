// Copyright (c) 2026 FPVSkyline. MIT License.

#include "Importer/Html2UMGPropertyApplier.h"

#include "Components/Border.h"
#include "Components/Button.h"
#include "Components/Image.h"
#include "Components/SlateWrapperTypes.h"
#include "Containers/SharedString.h"
#include "Dom/JsonValue.h"
#include "Engine/Texture2D.h"
#include "Html2UMGLog.h"
#include "Layout/Margin.h"
#include "Math/Color.h"
#include "Math/Vector2D.h"
#include "Math/Vector4.h"
#include "Styling/SlateBrush.h"
#include "Styling/SlateColor.h"
#include "Styling/SlateTypes.h"
#include "UObject/Class.h"
#include "UObject/EnumProperty.h"
#include "UObject/SoftObjectPtr.h"
#include "UObject/TextProperty.h"
#include "UObject/UnrealType.h"

namespace
{
	const TCHAR* const kSeverityInfo = TEXT("info");
	const TCHAR* const kSeverityWarning = TEXT("warning");

	/**
	 * UE 5.8 stores FJsonObject keys as UE::FSharedString (older builds use FString);
	 * these overloads keep the writer source-compatible with both.
	 */
	FString JsonKeyToString(const FString& InKey)
	{
		return InKey;
	}

	FString JsonKeyToString(const UE::FSharedString& InKey)
	{
		return FString(*InKey);
	}

	/** One JSON object member, with the key normalised to FString. */
	struct FJsonField
	{
		FString Name;
		TSharedPtr<FJsonValue> Value;
	};

	/** Copies the members of a JSON object into a sorted array (deterministic message order). */
	void CollectFields(const TSharedPtr<FJsonObject>& Object, TArray<FJsonField>& OutFields)
	{
		OutFields.Reset();
		if (!Object.IsValid())
		{
			return;
		}

		OutFields.Reserve(Object->Values.Num());
		for (const auto& Pair : Object->Values)
		{
			FJsonField& Field = OutFields.AddDefaulted_GetRef();
			Field.Name = JsonKeyToString(Pair.Key);
			Field.Value = Pair.Value;
		}

		OutFields.Sort([](const FJsonField& A, const FJsonField& B) { return A.Name < B.Name; });
	}

	/**
	 * UE spells boolean members with a "b" prefix (bAutoSize), while layout JSON (hand written,
	 * third-party, or agent generated) very often drops it - or adds one where UE has none.
	 * Returns the alternate spelling to try when the literal name did not match, or an empty
	 * string when there is nothing sensible to try.
	 *
	 * This is a *fallback only*: it can never mask a real typo, because the alternate name still
	 * has to exist on the class, and a genuinely wrong key keeps reporting "is not a property of".
	 */
	FString AlternatePropertyName(const FString& Name)
	{
		if (Name.Len() >= 2 && (Name[0] == TEXT('b') || Name[0] == TEXT('B')) && FChar::IsUpper(Name[1]))
		{
			// bAutoSize -> AutoSize
			return Name.RightChop(1);
		}

		if (!Name.IsEmpty())
		{
			// AutoSize / autoSize -> bAutoSize
			FString Capitalized = Name;
			Capitalized[0] = FChar::ToUpper(Capitalized[0]);
			return FString(TEXT("b")) + Capitalized;
		}

		return FString();
	}

	/** Everything a single application pass needs. */
	struct FApplyContext
	{
		const FH2UObjectResolver* Resolver = nullptr;
		const FH2UMessageSink* Sink = nullptr;
		const FH2UBrushContext* BrushOptions = nullptr;
		FString Prefix;
		FH2UApplyStats Stats;
		int32 Depth = 0;

		void Message(const TCHAR* Severity, const FString& Text) const
		{
			if (Sink && *Sink)
			{
				(*Sink)(FH2UMessage(Severity, Text));
			}
			UE_LOG(LogHtml2UMG, Log, TEXT("Html2UMG [%s] %s"), Severity, *Text);
		}

		void Warn(const FString& Text) const { Message(kSeverityWarning, Text); }
		void Info(const FString& Text) const { Message(kSeverityInfo, Text); }
	};

	bool ApplyPropertyValue(void* Container, FProperty* Property, const TSharedPtr<FJsonValue>& Value, FApplyContext& Context);
	bool ApplyStructValue(void* StructMemory, const UScriptStruct* Struct, const TSharedPtr<FJsonValue>& Value, FApplyContext& Context);
	bool BuildBrushFromJson(FSlateBrush& OutBrush, const TSharedPtr<FJsonObject>& Object, FApplyContext& Context);

	const TCHAR* JsonKindName(const TSharedPtr<FJsonValue>& Value)
	{
		if (!Value.IsValid())
		{
			return TEXT("null");
		}

		switch (Value->Type)
		{
		case EJson::String:
			return TEXT("string");
		case EJson::Number:
			return TEXT("number");
		case EJson::Boolean:
			return TEXT("bool");
		case EJson::Array:
			return TEXT("array");
		case EJson::Object:
			return TEXT("object");
		default:
			return TEXT("null");
		}
	}

	/** Scalar-to-string coercion, so "Text": 42 and "Text": true behave sensibly. */
	bool JsonToString(const TSharedPtr<FJsonValue>& Value, FString& OutText)
	{
		if (!Value.IsValid())
		{
			return false;
		}

		if (Value->TryGetString(OutText))
		{
			return true;
		}

		double Number = 0.0;
		if (Value->TryGetNumber(Number))
		{
			OutText = FString::SanitizeFloat(Number);
			if (FMath::IsNearlyEqual(Number, FMath::RoundToDouble(Number)))
			{
				OutText = FString::Printf(TEXT("%lld"), static_cast<int64>(FMath::RoundToDouble(Number)));
			}
			return true;
		}

		bool bBoolValue = false;
		if (Value->TryGetBool(bBoolValue))
		{
			OutText = bBoolValue ? TEXT("true") : TEXT("false");
			return true;
		}

		return false;
	}

	/** Converts a JSON value to a linear colour, accepting [r,g,b] / [r,g,b,a] and { "Hex": "#RRGGBBAA" }. */
	bool LinearColorFromJson(const TSharedPtr<FJsonValue>& Value, FLinearColor& OutColor)
	{
		if (!Value.IsValid())
		{
			return false;
		}

		if (Value->Type == EJson::Array)
		{
			const TArray<TSharedPtr<FJsonValue>>& Items = Value->AsArray();
			if (Items.Num() < 3)
			{
				return false;
			}

			double Components[4] = { 1.0, 1.0, 1.0, 1.0 };
			for (int32 Index = 0; Index < 4 && Index < Items.Num(); ++Index)
			{
				if (!Items[Index].IsValid() || !Items[Index]->TryGetNumber(Components[Index]))
				{
					return false;
				}
			}

			OutColor = FLinearColor(
				static_cast<float>(Components[0]),
				static_cast<float>(Components[1]),
				static_cast<float>(Components[2]),
				static_cast<float>(Components[3]));
			return true;
		}

		if (Value->Type == EJson::Object)
		{
			const TSharedPtr<FJsonObject> Object = Value->AsObject();
			if (!Object.IsValid())
			{
				return false;
			}

			FLinearColor Parsed(0.0f, 0.0f, 0.0f, 1.0f);
			bool bAny = false;
			double Component = 0.0;
			if (Object->TryGetNumberField(TEXT("R"), Component)) { Parsed.R = static_cast<float>(Component); bAny = true; }
			if (Object->TryGetNumberField(TEXT("G"), Component)) { Parsed.G = static_cast<float>(Component); bAny = true; }
			if (Object->TryGetNumberField(TEXT("B"), Component)) { Parsed.B = static_cast<float>(Component); bAny = true; }
			if (Object->TryGetNumberField(TEXT("A"), Component)) { Parsed.A = static_cast<float>(Component); bAny = true; }

			if (bAny)
			{
				OutColor = Parsed;
				return true;
			}

			FString Hex;
			if (Object->TryGetStringField(TEXT("Hex"), Hex) || Object->TryGetStringField(TEXT("hex"), Hex))
			{
				OutColor = FLinearColor::FromSRGBColor(FColor::FromHex(Hex));
				return true;
			}

			return false;
		}

		if (Value->Type == EJson::String)
		{
			return OutColor.InitFromString(Value->AsString());
		}

		return false;
	}

	/** [x, y] or { "X": x, "Y": y } */
	bool Vector2FromJson(const TSharedPtr<FJsonValue>& Value, FVector2D& OutVector)
	{
		if (!Value.IsValid())
		{
			return false;
		}

		if (Value->Type == EJson::Array)
		{
			const TArray<TSharedPtr<FJsonValue>>& Items = Value->AsArray();
			if (Items.Num() < 2)
			{
				return false;
			}

			double X = 0.0;
			double Y = 0.0;
			if (!Items[0].IsValid() || !Items[0]->TryGetNumber(X) || !Items[1].IsValid() || !Items[1]->TryGetNumber(Y))
			{
				return false;
			}

			OutVector = FVector2D(X, Y);
			return true;
		}

		if (Value->Type == EJson::Object)
		{
			const TSharedPtr<FJsonObject> Object = Value->AsObject();
			if (!Object.IsValid())
			{
				return false;
			}

			double X = 0.0;
			double Y = 0.0;
			if (Object->TryGetNumberField(TEXT("X"), X) && Object->TryGetNumberField(TEXT("Y"), Y))
			{
				OutVector = FVector2D(X, Y);
				return true;
			}
		}

		return false;
	}

	/** [left, top, right, bottom]; a single number applies to all four sides. */
	bool MarginFromJson(const TSharedPtr<FJsonValue>& Value, FMargin& OutMargin)
	{
		if (!Value.IsValid())
		{
			return false;
		}

		if (Value->Type == EJson::Number)
		{
			double All = 0.0;
			if (!Value->TryGetNumber(All))
			{
				return false;
			}
			OutMargin = FMargin(static_cast<float>(All));
			return true;
		}

		if (Value->Type == EJson::Array)
		{
			const TArray<TSharedPtr<FJsonValue>>& Items = Value->AsArray();
			double Components[4] = { 0.0, 0.0, 0.0, 0.0 };
			for (int32 Index = 0; Index < 4 && Index < Items.Num(); ++Index)
			{
				if (!Items[Index].IsValid() || !Items[Index]->TryGetNumber(Components[Index]))
				{
					return false;
				}
			}

			if (Items.Num() == 1)
			{
				OutMargin = FMargin(static_cast<float>(Components[0]));
			}
			else if (Items.Num() >= 4)
			{
				OutMargin = FMargin(
					static_cast<float>(Components[0]),
					static_cast<float>(Components[1]),
					static_cast<float>(Components[2]),
					static_cast<float>(Components[3]));
			}
			else if (Items.Num() == 2)
			{
				OutMargin = FMargin(static_cast<float>(Components[0]), static_cast<float>(Components[1]));
			}
			else
			{
				return false;
			}
			return true;
		}

		if (Value->Type == EJson::Object)
		{
			const TSharedPtr<FJsonObject> Object = Value->AsObject();
			if (!Object.IsValid())
			{
				return false;
			}

			double Left = 0.0;
			double Top = 0.0;
			double Right = 0.0;
			double Bottom = 0.0;
			Object->TryGetNumberField(TEXT("Left"), Left);
			Object->TryGetNumberField(TEXT("Top"), Top);
			Object->TryGetNumberField(TEXT("Right"), Right);
			Object->TryGetNumberField(TEXT("Bottom"), Bottom);
			OutMargin = FMargin(static_cast<float>(Left), static_cast<float>(Top), static_cast<float>(Right), static_cast<float>(Bottom));
			return true;
		}

		return false;
	}

	/**
	 * Matches an enum entry by name, tolerating "Enum::Value", a bare "Value",
	 * and the UMG alignment prefixes (HAlign_ / VAlign_).
	 */
	bool EnumValueFromString(const UEnum* Enum, const FString& InText, int64& OutValue)
	{
		if (!Enum)
		{
			return false;
		}

		const FString Wanted = InText.TrimStartAndEnd();
		if (Wanted.IsEmpty())
		{
			return false;
		}

		FString Short = Wanted;
		int32 SeparatorIndex = INDEX_NONE;
		if (Short.FindLastChar(TEXT(':'), SeparatorIndex))
		{
			Short = Short.RightChop(SeparatorIndex + 1);
		}

		static const TCHAR* Prefixes[] = { TEXT("HAlign_"), TEXT("VAlign_"), TEXT("Type_") };

		for (int32 Index = 0; Index < Enum->NumEnums(); ++Index)
		{
			const FString FullName = Enum->GetNameStringByIndex(Index);
			if (FullName.EndsWith(TEXT("_MAX")) || FullName.EndsWith(TEXT("__MAX")))
			{
				continue;
			}

			if (FullName.Equals(Wanted, ESearchCase::IgnoreCase))
			{
				OutValue = Enum->GetValueByIndex(Index);
				return true;
			}

			FString Candidate = FullName;
			int32 CandidateSeparator = INDEX_NONE;
			if (Candidate.FindLastChar(TEXT(':'), CandidateSeparator))
			{
				Candidate = Candidate.RightChop(CandidateSeparator + 1);
			}

			if (Candidate.Equals(Short, ESearchCase::IgnoreCase))
			{
				OutValue = Enum->GetValueByIndex(Index);
				return true;
			}

			for (const TCHAR* Prefix : Prefixes)
			{
				const FString PrefixString(Prefix);
				if (Candidate.Len() > PrefixString.Len()
					&& Candidate.StartsWith(PrefixString, ESearchCase::IgnoreCase)
					&& Candidate.RightChop(PrefixString.Len()).Equals(Short, ESearchCase::IgnoreCase))
				{
					OutValue = Enum->GetValueByIndex(Index);
					return true;
				}
			}
		}

		return false;
	}

	/** Reads a JSON string and resolves it through a UEnum ("RoundedBox" -> ESlateBrushDrawType::RoundedBox). */
	template<typename EnumType>
	bool ParseEnumFromJson(const UEnum* Enum, const TSharedPtr<FJsonValue>& Value, EnumType& OutValue)
	{
		if (!Value.IsValid())
		{
			return false;
		}

		if (Value->Type == EJson::String)
		{
			int64 EnumValue = 0;
			if (EnumValueFromString(Enum, Value->AsString(), EnumValue))
			{
				OutValue = static_cast<EnumType>(EnumValue);
				return true;
			}
			return false;
		}

		double Number = 0.0;
		if (Value->TryGetNumber(Number))
		{
			OutValue = static_cast<EnumType>(static_cast<int64>(Number));
			return true;
		}

		return false;
	}

	FString StructFieldsHint(const UScriptStruct* Struct)
	{
		FString Hint;
		int32 Count = 0;
		for (TFieldIterator<FProperty> It(Struct); It; ++It)
		{
			if (Count++ > 0)
			{
				Hint += TEXT(", ");
			}
			Hint += It->GetName();
			if (Count >= 16)
			{
				Hint += TEXT(", ...");
				break;
			}
		}
		return Hint;
	}

	/** Walks a JSON object and writes each key onto its same-named field of the struct. */
	bool ApplyStructFields(void* StructMemory, const UScriptStruct* Struct, const TSharedPtr<FJsonObject>& Object, FApplyContext& Context)
	{
		if (!Object.IsValid())
		{
			return false;
		}

		TArray<FJsonField> Fields;
		CollectFields(Object, Fields);

		bool bAllApplied = true;
		for (const FJsonField& Field : Fields)
		{
			FProperty* Property = FHtml2UMGPropertyApplier::FindStructProperty(Struct, Field.Name);
			if (!Property)
			{
				++Context.Stats.UnknownKeys;
				Context.Warn(FString::Printf(TEXT("%s: '%s' is not a property of %s (known: %s)"),
					*Context.Prefix, *Field.Name, *Struct->GetName(), *StructFieldsHint(Struct)));
				bAllApplied = false;
				continue;
			}

			if (!ApplyPropertyValue(StructMemory, Property, Field.Value, Context))
			{
				bAllApplied = false;
			}
		}

		return bAllApplied;
	}

	bool ApplyVector2DStruct(void* StructMemory, const UScriptStruct* Struct, const TSharedPtr<FJsonValue>& Value, FApplyContext& Context)
	{
		FVector2D Vector;
		if (Value.IsValid() && Value->Type != EJson::Object && Vector2FromJson(Value, Vector))
		{
			*static_cast<FVector2D*>(StructMemory) = Vector;
			return true;
		}

		if (Value.IsValid() && Value->Type == EJson::Object)
		{
			return ApplyStructFields(StructMemory, Struct, Value->AsObject(), Context);
		}

		Context.Warn(FString::Printf(TEXT("%s: %s expects [x, y], got %s"),
			*Context.Prefix, *Struct->GetName(), JsonKindName(Value)));
		return false;
	}

	bool ApplyStructValue(void* StructMemory, const UScriptStruct* Struct, const TSharedPtr<FJsonValue>& Value, FApplyContext& Context)
	{
		if (!StructMemory || !Struct)
		{
			return false;
		}

		if (!Value.IsValid())
		{
			return false;
		}

		if (Context.Depth > 32)
		{
			Context.Warn(FString::Printf(TEXT("%s: struct nesting deeper than 32, aborting."), *Context.Prefix));
			return false;
		}

		++Context.Depth;
		bool bResult = false;

		// ---- Slate / UMG math structs have an explicit JSON shape ----
		if (Struct == TBaseStructure<FVector2D>::Get())
		{
			bResult = ApplyVector2DStruct(StructMemory, Struct, Value, Context);
		}
		else if (Struct == TBaseStructure<FIntPoint>::Get())
		{
			FVector2D Vector;
			if (Vector2FromJson(Value, Vector))
			{
				*static_cast<FIntPoint*>(StructMemory) = FIntPoint(FMath::RoundToInt(Vector.X), FMath::RoundToInt(Vector.Y));
				bResult = true;
			}
			else
			{
				Context.Warn(FString::Printf(TEXT("%s: FIntPoint expects [x, y], got %s"), *Context.Prefix, JsonKindName(Value)));
			}
		}
		else if (Struct == TBaseStructure<FVector>::Get())
		{
			FVector Vector = FVector::ZeroVector;
			bool bOk = false;
			if (Value->Type == EJson::Array)
			{
				const TArray<TSharedPtr<FJsonValue>>& Items = Value->AsArray();
				if (Items.Num() >= 3 && Items[0].IsValid() && Items[1].IsValid() && Items[2].IsValid()
					&& Items[0]->TryGetNumber(Vector.X) && Items[1]->TryGetNumber(Vector.Y) && Items[2]->TryGetNumber(Vector.Z))
				{
					bOk = true;
				}
			}

			if (bOk)
			{
				*static_cast<FVector*>(StructMemory) = Vector;
				bResult = true;
			}
			else if (Value->Type == EJson::Object)
			{
				bResult = ApplyStructFields(StructMemory, Struct, Value->AsObject(), Context);
			}
			else
			{
				Context.Warn(FString::Printf(TEXT("%s: FVector expects [x, y, z], got %s"), *Context.Prefix, JsonKindName(Value)));
			}
		}
		else if (Struct == TBaseStructure<FVector4>::Get())
		{
			bool bOk = false;
			FVector4 Vector(0.0, 0.0, 0.0, 1.0);
			if (Value->Type == EJson::Array)
			{
				const TArray<TSharedPtr<FJsonValue>>& Items = Value->AsArray();
				if (Items.Num() >= 3
					&& Items[0].IsValid() && Items[1].IsValid() && Items[2].IsValid()
					&& Items[0]->TryGetNumber(Vector.X) && Items[1]->TryGetNumber(Vector.Y) && Items[2]->TryGetNumber(Vector.Z))
				{
					if (Items.Num() >= 4 && Items[3].IsValid())
					{
						Items[3]->TryGetNumber(Vector.W);
					}
					bOk = true;
				}
			}

			if (bOk)
			{
				*static_cast<FVector4*>(StructMemory) = Vector;
				bResult = true;
			}
			else if (Value->Type == EJson::Object)
			{
				bResult = ApplyStructFields(StructMemory, Struct, Value->AsObject(), Context);
			}
			else
			{
				Context.Warn(FString::Printf(TEXT("%s: FVector4 expects [x, y, z, w], got %s"), *Context.Prefix, JsonKindName(Value)));
			}
		}
		else if (Struct == TBaseStructure<FLinearColor>::Get())
		{
			FLinearColor Color;
			if (LinearColorFromJson(Value, Color))
			{
				*static_cast<FLinearColor*>(StructMemory) = Color;
				bResult = true;
			}
			else
			{
				Context.Warn(FString::Printf(TEXT("%s: FLinearColor expects [r, g, b, a], got %s"), *Context.Prefix, JsonKindName(Value)));
			}
		}
		else if (Struct == TBaseStructure<FMargin>::Get())
		{
			FMargin Margin;
			if (Value->Type != EJson::Object && MarginFromJson(Value, Margin))
			{
				*static_cast<FMargin*>(StructMemory) = Margin;
				bResult = true;
			}
			else if (Value->Type == EJson::Object)
			{
				bResult = ApplyStructFields(StructMemory, Struct, Value->AsObject(), Context);
			}
			else
			{
				Context.Warn(FString::Printf(TEXT("%s: FMargin expects [left, top, right, bottom], got %s"), *Context.Prefix, JsonKindName(Value)));
			}
		}
		else if (Struct == TBaseStructure<FSlateColor>::Get())
		{
			FSlateColor* SlateColor = static_cast<FSlateColor*>(StructMemory);
			FLinearColor Color;
			if (Value->Type == EJson::String)
			{
				const FString Text = Value->AsString();
				if (Text.Equals(TEXT("Foreground"), ESearchCase::IgnoreCase))
				{
					*SlateColor = FSlateColor::UseForeground();
					bResult = true;
				}
				else if (Text.Equals(TEXT("White"), ESearchCase::IgnoreCase))
				{
					*SlateColor = FSlateColor(FLinearColor::White);
					bResult = true;
				}
				else if (Text.Equals(TEXT("Black"), ESearchCase::IgnoreCase))
				{
					*SlateColor = FSlateColor(FLinearColor::Black);
					bResult = true;
				}
				else if (Text.Equals(TEXT("Transparent"), ESearchCase::IgnoreCase))
				{
					*SlateColor = FSlateColor(FLinearColor::Transparent);
					bResult = true;
				}
				else if (LinearColorFromJson(Value, Color))
				{
					*SlateColor = FSlateColor(Color);
					bResult = true;
				}
				else
				{
					Context.Warn(FString::Printf(TEXT("%s: '%s' is not a FSlateColor value"), *Context.Prefix, *Text));
				}
			}
			else if (LinearColorFromJson(Value, Color))
			{
				*SlateColor = FSlateColor(Color);
				bResult = true;
			}
			else if (Value->Type == EJson::Object)
			{
				bResult = ApplyStructFields(StructMemory, Struct, Value->AsObject(), Context);
			}
			else
			{
				Context.Warn(FString::Printf(TEXT("%s: FSlateColor expects [r, g, b, a], got %s"), *Context.Prefix, JsonKindName(Value)));
			}
		}
		else if (Struct == TBaseStructure<FSlateBrush>::Get())
		{
			if (Value->Type == EJson::Object)
			{
				FSlateBrush Brush = FSlateBrush();
				if (BuildBrushFromJson(Brush, Value->AsObject(), Context))
				{
					*static_cast<FSlateBrush*>(StructMemory) = Brush;
					bResult = true;
				}
			}
			else
			{
				Context.Warn(FString::Printf(TEXT("%s: FSlateBrush expects an object, got %s"), *Context.Prefix, JsonKindName(Value)));
			}
		}
		else if (Struct == TBaseStructure<FSlateChildSize>::Get())
		{
			if (Value->Type == EJson::Object)
			{
				bResult = ApplyStructFields(StructMemory, Struct, Value->AsObject(), Context);
			}
			else if (Value->Type == EJson::String)
			{
				FSlateChildSize Size;
				ESlateSizeRule::Type Rule = ESlateSizeRule::Fill;
				if (ParseEnumFromJson(StaticEnum<ESlateSizeRule::Type>(), Value, Rule))
				{
					Size.SizeRule = Rule;
					*static_cast<FSlateChildSize*>(StructMemory) = Size;
					bResult = true;
				}
				else
				{
					Context.Warn(FString::Printf(TEXT("%s: FSlateChildSize expects \"Automatic\" or \"Fill\", got \"%s\""),
						*Context.Prefix, *Value->AsString()));
				}
			}
			else
			{
				Context.Warn(FString::Printf(TEXT("%s: FSlateChildSize expects an object, got %s"), *Context.Prefix, JsonKindName(Value)));
			}
		}
		else if (Value->Type == EJson::Object)
		{
			bResult = ApplyStructFields(StructMemory, Struct, Value->AsObject(), Context);
		}
		else
		{
			Context.Warn(FString::Printf(TEXT("%s: %s expects an object, got %s"),
				*Context.Prefix, *Struct->GetName(), JsonKindName(Value)));
		}

		--Context.Depth;
		return bResult;
	}

	/** Contract §4 -> FSlateBrush. */
	bool BuildBrushFromJson(FSlateBrush& OutBrush, const TSharedPtr<FJsonObject>& Object, FApplyContext& Context)
	{
		if (!Object.IsValid())
		{
			return false;
		}

		FLinearColor Tint(1.0f, 1.0f, 1.0f, 1.0f);
		bool bHasTint = false;
		FVector4 Radii(0.0f, 0.0f, 0.0f, 0.0f);
		bool bHasRadii = false;
		FLinearColor OutlineColor(1.0f, 1.0f, 1.0f, 0.0f);
		bool bHasOutlineColor = false;
		double OutlineWidth = 0.0;
		bool bHasOutlineWidth = false;
		FString TextureRef;
		FMargin Margin(0.0f, 0.0f, 0.0f, 0.0f);
		bool bHasMargin = false;
		FVector2D ImageSize(0.0, 0.0);
		bool bHasImageSize = false;
		FString DrawAsName;
		bool bHasDrawAs = false;
		ESlateBrushTileType::Type Tiling = ESlateBrushTileType::NoTile;
		bool bHasTiling = false;
		bool bOk = true;

		TArray<FJsonField> Fields;
		CollectFields(Object, Fields);

		for (const FJsonField& Field : Fields)
		{
			const TSharedPtr<FJsonValue> Value = Field.Value;
			const FString Lower = Field.Name.ToLower();

			if (Lower == TEXT("drawas") || Lower == TEXT("drawtype"))
			{
				if (Value.IsValid() && Value->Type == EJson::String)
				{
					DrawAsName = Value->AsString();
					bHasDrawAs = true;
				}
				else
				{
					bOk = false;
					Context.Warn(FString::Printf(TEXT("%s: brush.drawAs expects a string, got %s"), *Context.Prefix, JsonKindName(Value)));
				}
			}
			else if (Lower == TEXT("tint") || Lower == TEXT("tintcolor"))
			{
				if (LinearColorFromJson(Value, Tint))
				{
					bHasTint = true;
				}
				else
				{
					bOk = false;
					Context.Warn(FString::Printf(TEXT("%s: brush.tint expects [r, g, b, a], got %s"), *Context.Prefix, JsonKindName(Value)));
				}
			}
			else if (Lower == TEXT("cornerradii") || Lower == TEXT("radii"))
			{
				const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
				if (Value.IsValid() && Value->Type == EJson::Array)
				{
					Items = &Value->AsArray();
				}

				double Components[4] = { 0.0, 0.0, 0.0, 0.0 };
				if (Items && Items->Num() >= 4)
				{
					bool bParsed = true;
					for (int32 Index = 0; Index < 4; ++Index)
					{
						if (!(*Items)[Index].IsValid() || !(*Items)[Index]->TryGetNumber(Components[Index]))
						{
							bParsed = false;
							break;
						}
					}
					if (bParsed)
					{
						Radii = FVector4(Components[0], Components[1], Components[2], Components[3]);
						bHasRadii = true;
					}
					else
					{
						bOk = false;
						Context.Warn(FString::Printf(TEXT("%s: brush.cornerRadii expects 4 numbers [TL, TR, BR, BL]"), *Context.Prefix));
					}
				}
				else if (Items && Items->Num() == 1 && (*Items)[0].IsValid() && (*Items)[0]->TryGetNumber(Components[0]))
				{
					Radii = FVector4(Components[0], Components[0], Components[0], Components[0]);
					bHasRadii = true;
				}
				else
				{
					bOk = false;
					Context.Warn(FString::Printf(TEXT("%s: brush.cornerRadii expects 4 numbers [TL, TR, BR, BL], got %s"), *Context.Prefix, JsonKindName(Value)));
				}
			}
			else if (Lower == TEXT("states"))
			{
				// Per-state brush overrides (hovered/pressed/disabled). They are consumed by the
				// UButton branch of ApplyBrush; the single FSlateBrush built here ignores them.
			}
			else if (Lower == TEXT("outlinewidth"))
			{
				if (Value.IsValid() && Value->TryGetNumber(OutlineWidth))
				{
					bHasOutlineWidth = true;
				}
				else
				{
					bOk = false;
					Context.Warn(FString::Printf(TEXT("%s: brush.outlineWidth expects a number, got %s"), *Context.Prefix, JsonKindName(Value)));
				}
			}
			else if (Lower == TEXT("outlinecolor"))
			{
				if (LinearColorFromJson(Value, OutlineColor))
				{
					bHasOutlineColor = true;
				}
				else
				{
					bOk = false;
					Context.Warn(FString::Printf(TEXT("%s: brush.outlineColor expects [r, g, b, a], got %s"), *Context.Prefix, JsonKindName(Value)));
				}
			}
			else if (Lower == TEXT("texture") || Lower == TEXT("resourceobject") || Lower == TEXT("resource"))
			{
				if (JsonToString(Value, TextureRef))
				{
					// resolved below, once the whole block has been read
				}
				else
				{
					bOk = false;
					Context.Warn(FString::Printf(TEXT("%s: brush.texture expects an asset reference, got %s"), *Context.Prefix, JsonKindName(Value)));
				}
			}
			else if (Lower == TEXT("margin"))
			{
				if (MarginFromJson(Value, Margin))
				{
					bHasMargin = true;
				}
				else
				{
					bOk = false;
					Context.Warn(FString::Printf(TEXT("%s: brush.margin expects [left, top, right, bottom], got %s"), *Context.Prefix, JsonKindName(Value)));
				}
			}
			else if (Lower == TEXT("imagesize"))
			{
				if (Vector2FromJson(Value, ImageSize))
				{
					bHasImageSize = true;
				}
				else
				{
					bOk = false;
					Context.Warn(FString::Printf(TEXT("%s: brush.imageSize expects [x, y], got %s"), *Context.Prefix, JsonKindName(Value)));
				}
			}
			else if (Lower == TEXT("tiling"))
			{
				if (ParseEnumFromJson(StaticEnum<ESlateBrushTileType::Type>(), Value, Tiling))
				{
					bHasTiling = true;
				}
				else
				{
					bOk = false;
					Context.Warn(FString::Printf(TEXT("%s: brush.tiling expects NoTile|Horizontal|Vertical|Both, got %s"), *Context.Prefix, JsonKindName(Value)));
				}
			}
			else
			{
				bOk = false;
				Context.Warn(FString::Printf(TEXT("%s: brush key '%s' is not known (expected drawAs|tint|cornerRadii|outlineWidth|outlineColor|texture|margin|imageSize|tiling)"),
					*Context.Prefix, *Field.Name));
			}
		}

		// ---- compose ----
		ESlateBrushDrawType::Type DrawAs = ESlateBrushDrawType::Image;
		if (bHasDrawAs)
		{
			int64 DrawAsValue = 0;
			if (EnumValueFromString(StaticEnum<ESlateBrushDrawType::Type>(), DrawAsName, DrawAsValue))
			{
				DrawAs = static_cast<ESlateBrushDrawType::Type>(DrawAsValue);
			}
			else
			{
				bOk = false;
				Context.Warn(FString::Printf(TEXT("%s: brush.drawAs '%s' is not one of NoDrawType|Box|Border|Image|RoundedBox"),
					*Context.Prefix, *DrawAsName));
				DrawAs = ESlateBrushDrawType::Box;
			}
		}
		else if (!TextureRef.IsEmpty())
		{
			DrawAs = ESlateBrushDrawType::Image;
		}
		else if (bHasRadii)
		{
			DrawAs = ESlateBrushDrawType::RoundedBox;
		}
		else
		{
			DrawAs = ESlateBrushDrawType::Box;
		}

		OutBrush.DrawAs = DrawAs;
		OutBrush.TintColor = FSlateColor(Tint);
		if (bHasMargin)
		{
			OutBrush.Margin = Margin;
		}
		if (bHasTiling)
		{
			OutBrush.Tiling = Tiling;
		}
		if (bHasImageSize)
		{
			OutBrush.ImageSize.X = static_cast<float>(ImageSize.X);
			OutBrush.ImageSize.Y = static_cast<float>(ImageSize.Y);
		}

		if (!TextureRef.IsEmpty())
		{
			UObject* Resolved = (Context.Resolver && *Context.Resolver)
				? (*Context.Resolver)(TextureRef, UTexture2D::StaticClass(), Context.Prefix)
				: nullptr;
			if (Resolved)
			{
				OutBrush.SetResourceObject(Resolved);
				// A brush built field-by-field keeps FSlateBrush's default ImageType (NoImage), and
				// Slate then treats it as having no image data - widget styles that draw through
				// SSlider/SImage check it, so a Slider bar or CheckBox image with a perfectly good
				// texture painted nothing. Measured: same layout, same texture, tint-only brush draws
				// (solid colour), textured brush draws 0 pixels until this is set. Border/Image draw
				// paths do not consult it, which is why only control styles looked broken.
				OutBrush.ImageType = ESlateBrushImageType::FullColor;
			}
			else
			{
				bOk = false;
				Context.Warn(FString::Printf(TEXT("%s: brush.texture '%s' could not be resolved"), *Context.Prefix, *TextureRef));
			}
		}

		// Outline / rounded corners. The contract always means FixedRadius with explicit pixel radii.
		OutBrush.OutlineSettings.RoundingType = ESlateBrushRoundingType::FixedRadius;
		OutBrush.OutlineSettings.Width = static_cast<float>(OutlineWidth);
		OutBrush.OutlineSettings.Color = FSlateColor(OutlineColor);

		if (bHasRadii || bHasOutlineColor || bHasOutlineWidth)
		{
			FVector4 Clamped = Radii;
			const FVector2D WidgetSize = Context.BrushOptions ? Context.BrushOptions->WidgetSize : FVector2D::ZeroVector;
			if (WidgetSize.X > 0.0 && WidgetSize.Y > 0.0)
			{
				// Radii larger than half of the shorter side bleed outside the widget; clamp them.
				const float HalfShortSide = static_cast<float>(FMath::Min(WidgetSize.X, WidgetSize.Y)) * 0.5f;
				const float MaxRadius = FMath::Max(0.0f, HalfShortSide - static_cast<float>(OutlineWidth) * 2.0f);
				Clamped.X = FMath::Clamp(static_cast<float>(Clamped.X), 0.0f, MaxRadius);
				Clamped.Y = FMath::Clamp(static_cast<float>(Clamped.Y), 0.0f, MaxRadius);
				Clamped.Z = FMath::Clamp(static_cast<float>(Clamped.Z), 0.0f, MaxRadius);
				Clamped.W = FMath::Clamp(static_cast<float>(Clamped.W), 0.0f, MaxRadius);

				if (!Radii.Equals(Clamped, 0.01f))
				{
					Context.Info(FString::Printf(TEXT("%s: corner radii [%g, %g, %g, %g] clamped to the widget size %.0fx%.0f"),
						*Context.Prefix, Radii.X, Radii.Y, Radii.Z, Radii.W, WidgetSize.X, WidgetSize.Y));
				}
			}
			OutBrush.OutlineSettings.CornerRadii = Clamped;
		}

		return bOk;
	}

	/**
	 * A fractional number aimed at an enum property is silently truncated by the byte write, which is
	 * how "ContentHAlign": 0.5 turned into HAlign_Left (0) on a UH2URelativeBox that declared its
	 * alignment as TEnumAsByte. The value still lands (truncated) so old layouts keep working, but say
	 * so loudly - the fix is always "send the enum name" or "make the property a float".
	 */
	void WarnAboutTruncatedEnum(FApplyContext& Context, const FProperty* Property, const UEnum* Enum, double Number)
	{
		const double Truncated = FMath::TruncToDouble(Number);
		if (FMath::IsNearlyEqual(Number, Truncated))
		{
			return;
		}

		Context.Warn(FString::Printf(
			TEXT("%s: property '%s' is an enum (%s) but got %g; the fraction is dropped and value %lld is used. ")
			TEXT("Send an enum name instead (a 0..1 fraction means the property should be a float)."),
			*Context.Prefix, *Property->GetName(), Enum ? *Enum->GetName() : TEXT("<unknown enum>"),
			Number, static_cast<long long>(static_cast<int64>(Truncated))));
	}

	/** Writes one JSON value into one property of the container (UObject or struct memory). */
	bool ApplyPropertyValue(void* Container, FProperty* Property, const TSharedPtr<FJsonValue>& Value, FApplyContext& Context)
	{
		if (!Container || !Property)
		{
			return false;
		}

		if (!Value.IsValid() || Value->Type == EJson::Null || Value->Type == EJson::None)
		{
			++Context.Stats.Skipped;
			return false;
		}

		const FString TypeName = FHtml2UMGPropertyApplier::DescribePropertyType(Property);
		void* Dest = Property->ContainerPtrToValuePtr<void>(Container);

		// ---- struct: recurse ----
		if (const FStructProperty* StructProperty = CastField<FStructProperty>(Property))
		{
			if (ApplyStructValue(Dest, StructProperty->Struct, Value, Context))
			{
				++Context.Stats.Applied;
				return true;
			}
			++Context.Stats.Failed;
			return false;
		}

		// ---- object / class: resolve an asset reference ----
		if (const FObjectProperty* ObjectProperty = CastField<FObjectProperty>(Property))
		{
			FString Reference;
			if (!Value->TryGetString(Reference))
			{
				++Context.Stats.Failed;
				Context.Warn(FString::Printf(TEXT("%s: '%s' (%s) expects an asset reference string, got %s"),
					*Context.Prefix, *Property->GetName(), *TypeName, JsonKindName(Value)));
				return false;
			}

			if (Reference.IsEmpty())
			{
				ObjectProperty->SetObjectPropertyValue(Dest, nullptr);
				++Context.Stats.Applied;
				return true;
			}

			UClass* ExpectedClass = ObjectProperty->PropertyClass;
			UObject* Resolved = (Context.Resolver && *Context.Resolver)
				? (*Context.Resolver)(Reference, ExpectedClass, Context.Prefix)
				: nullptr;

			if (!Resolved)
			{
				++Context.Stats.Failed;
				Context.Warn(FString::Printf(TEXT("%s: could not resolve '%s' for property '%s' (%s)"),
					*Context.Prefix, *Reference, *Property->GetName(), *TypeName));
				return false;
			}

			if (ExpectedClass && !Resolved->IsA(ExpectedClass))
			{
				++Context.Stats.Failed;
				Context.Warn(FString::Printf(TEXT("%s: '%s' resolved to %s but property '%s' wants %s"),
					*Context.Prefix, *Reference, *Resolved->GetClass()->GetName(), *Property->GetName(), *ExpectedClass->GetName()));
				return false;
			}

			ObjectProperty->SetObjectPropertyValue(Dest, Resolved);
			++Context.Stats.Applied;
			return true;
		}

		if (const FSoftObjectProperty* SoftProperty = CastField<FSoftObjectProperty>(Property))
		{
			FString Reference;
			if (!Value->TryGetString(Reference))
			{
				++Context.Stats.Failed;
				Context.Warn(FString::Printf(TEXT("%s: '%s' (%s) expects an asset reference string, got %s"),
					*Context.Prefix, *Property->GetName(), *TypeName, JsonKindName(Value)));
				return false;
			}

			UObject* Resolved = (Context.Resolver && *Context.Resolver)
				? (*Context.Resolver)(Reference, SoftProperty->PropertyClass, Context.Prefix)
				: nullptr;

			FSoftObjectPtr* SoftPtr = static_cast<FSoftObjectPtr*>(Dest);
			if (Resolved)
			{
				*SoftPtr = FSoftObjectPtr(Resolved);
			}
			else if (Reference.StartsWith(TEXT("/")))
			{
				*SoftPtr = FSoftObjectPtr(FSoftObjectPath(Reference));
				Context.Info(FString::Printf(TEXT("%s: '%s' stored as an unloaded soft reference on '%s'"),
					*Context.Prefix, *Reference, *Property->GetName()));
			}
			else
			{
				++Context.Stats.Failed;
				Context.Warn(FString::Printf(TEXT("%s: could not resolve '%s' for property '%s' (%s)"),
					*Context.Prefix, *Reference, *Property->GetName(), *TypeName));
				return false;
			}

			++Context.Stats.Applied;
			return true;
		}

		// ---- bool ----
		if (const FBoolProperty* BoolProperty = CastField<FBoolProperty>(Property))
		{
			bool bBoolValue = false;
			if (!Value->TryGetBool(bBoolValue))
			{
				double Number = 0.0;
				FString Text;
				if (Value->TryGetNumber(Number))
				{
					bBoolValue = !FMath::IsNearlyZero(Number);
				}
				else if (Value->TryGetString(Text))
				{
					bBoolValue = Text.Equals(TEXT("true"), ESearchCase::IgnoreCase) || Text == TEXT("1");
				}
				else
				{
					++Context.Stats.Failed;
					Context.Warn(FString::Printf(TEXT("%s: '%s' (%s) expects a bool, got %s"),
						*Context.Prefix, *Property->GetName(), *TypeName, JsonKindName(Value)));
					return false;
				}
			}

			BoolProperty->SetPropertyValue(Dest, bBoolValue);
			++Context.Stats.Applied;
			return true;
		}

		// ---- enums ----
		if (const FEnumProperty* EnumProperty = CastField<FEnumProperty>(Property))
		{
			UEnum* Enum = EnumProperty->GetEnum();
			FNumericProperty* Underlying = EnumProperty->GetUnderlyingProperty();
			int64 EnumValue = 0;
			if (Value->Type == EJson::String)
			{
				if (!EnumValueFromString(Enum, Value->AsString(), EnumValue))
				{
					++Context.Stats.Failed;
					Context.Warn(FString::Printf(TEXT("%s: '%s' is not a value of %s (property '%s')"),
						*Context.Prefix, *Value->AsString(), Enum ? *Enum->GetName() : TEXT("<unknown enum>"), *Property->GetName()));
					return false;
				}
			}
			else
			{
				double Number = 0.0;
				if (!Value->TryGetNumber(Number))
				{
					++Context.Stats.Failed;
					Context.Warn(FString::Printf(TEXT("%s: '%s' (%s) expects an enum name, got %s"),
						*Context.Prefix, *Property->GetName(), *TypeName, JsonKindName(Value)));
					return false;
				}
				EnumValue = static_cast<int64>(Number);
				WarnAboutTruncatedEnum(Context, Property, Enum, Number);
			}

			if (Underlying)
			{
				Underlying->SetIntPropertyValue(Dest, EnumValue);
			}
			++Context.Stats.Applied;
			return true;
		}

		if (const FByteProperty* ByteProperty = CastField<FByteProperty>(Property))
		{
			if (UEnum* Enum = ByteProperty->Enum)
			{
				int64 EnumValue = 0;
				if (Value->Type == EJson::String)
				{
					if (!EnumValueFromString(Enum, Value->AsString(), EnumValue))
					{
						++Context.Stats.Failed;
						Context.Warn(FString::Printf(TEXT("%s: '%s' is not a value of %s (property '%s')"),
							*Context.Prefix, *Value->AsString(), *Enum->GetName(), *Property->GetName()));
						return false;
					}
				}
				else
				{
					double Number = 0.0;
					if (!Value->TryGetNumber(Number))
					{
						++Context.Stats.Failed;
						Context.Warn(FString::Printf(TEXT("%s: '%s' (%s) expects an enum name, got %s"),
							*Context.Prefix, *Property->GetName(), *TypeName, JsonKindName(Value)));
						return false;
					}
					EnumValue = static_cast<int64>(Number);
					WarnAboutTruncatedEnum(Context, Property, Enum, Number);
				}

				ByteProperty->SetIntPropertyValue(Dest, EnumValue);
				++Context.Stats.Applied;
				return true;
			}
		}

		// ---- numbers (int32/int64/float/double/uint8) ----
		if (const FNumericProperty* NumericProperty = CastField<FNumericProperty>(Property))
		{
			double Number = 0.0;
			bool bGotNumber = Value->TryGetNumber(Number);
			if (!bGotNumber)
			{
				bool bBoolValue = false;
				FString Text;
				if (Value->TryGetBool(bBoolValue))
				{
					Number = bBoolValue ? 1.0 : 0.0;
					bGotNumber = true;
				}
				else if (Value->TryGetString(Text) && Text.IsNumeric())
				{
					Number = FCString::Atod(*Text);
					bGotNumber = true;
				}
			}

			if (!bGotNumber)
			{
				++Context.Stats.Failed;
				Context.Warn(FString::Printf(TEXT("%s: '%s' (%s) expects a number, got %s"),
					*Context.Prefix, *Property->GetName(), *TypeName, JsonKindName(Value)));
				return false;
			}

			if (NumericProperty->IsFloatingPoint())
			{
				NumericProperty->SetFloatingPointPropertyValue(Dest, Number);
			}
			else
			{
				NumericProperty->SetIntPropertyValue(Dest, static_cast<int64>(FMath::RoundToDouble(Number)));
			}
			++Context.Stats.Applied;
			return true;
		}

		// ---- strings ----
		if (const FStrProperty* StringProperty = CastField<FStrProperty>(Property))
		{
			FString Text;
			if (!JsonToString(Value, Text))
			{
				++Context.Stats.Failed;
				Context.Warn(FString::Printf(TEXT("%s: '%s' (%s) expects a string, got %s"),
					*Context.Prefix, *Property->GetName(), *TypeName, JsonKindName(Value)));
				return false;
			}

			StringProperty->SetPropertyValue(Dest, Text);
			++Context.Stats.Applied;
			return true;
		}

		if (const FNameProperty* NameProperty = CastField<FNameProperty>(Property))
		{
			FString Text;
			if (!JsonToString(Value, Text))
			{
				++Context.Stats.Failed;
				Context.Warn(FString::Printf(TEXT("%s: '%s' (%s) expects a string, got %s"),
					*Context.Prefix, *Property->GetName(), *TypeName, JsonKindName(Value)));
				return false;
			}

			NameProperty->SetPropertyValue(Dest, FName(*Text));
			++Context.Stats.Applied;
			return true;
		}

		if (const FTextProperty* TextProperty = CastField<FTextProperty>(Property))
		{
			FString Text;
			if (!JsonToString(Value, Text))
			{
				++Context.Stats.Failed;
				Context.Warn(FString::Printf(TEXT("%s: '%s' (%s) expects a string, got %s"),
					*Context.Prefix, *Property->GetName(), *TypeName, JsonKindName(Value)));
				return false;
			}

			TextProperty->SetPropertyValue(Dest, FText::FromString(Text));
			++Context.Stats.Applied;
			return true;
		}

		if (const FArrayProperty* ArrayProperty = CastField<FArrayProperty>(Property))
		{
			const TArray<TSharedPtr<FJsonValue>>* JsonArray = nullptr;
			if (!Value->TryGetArray(JsonArray) || JsonArray == nullptr)
			{
				++Context.Stats.Failed;
				Context.Warn(FString::Printf(TEXT("%s: '%s' (TArray) expects an array, got %s"),
					*Context.Prefix, *Property->GetName(), JsonKindName(Value)));
				return false;
			}

			// Validate the element type before touching the container, so a failed write leaves
			// the previous value intact instead of emptying it.
			const bool bStringy = CastField<FStrProperty>(ArrayProperty->Inner) != nullptr
				|| CastField<FNameProperty>(ArrayProperty->Inner) != nullptr
				|| CastField<FTextProperty>(ArrayProperty->Inner) != nullptr;
			if (!bStringy)
			{
				++Context.Stats.Failed;
				Context.Warn(FString::Printf(TEXT("%s: '%s' is a TArray of %s, which the reflection writer cannot fill yet"),
					*Context.Prefix, *Property->GetName(), *ArrayProperty->Inner->GetCPPType()));
				return false;
			}

			FScriptArrayHelper Helper(ArrayProperty, Dest);
			Helper.EmptyValues();
			Helper.Resize((*JsonArray).Num());

			for (int32 Index = 0; Index < (*JsonArray).Num(); ++Index)
			{
				FString ElementText;
				if (!JsonToString((*JsonArray)[Index], ElementText))
				{
					continue;
				}

				void* ElementAddress = Helper.GetRawPtr(Index);

				if (const FStrProperty* InnerString = CastField<FStrProperty>(ArrayProperty->Inner))
				{
					InnerString->SetPropertyValue(ElementAddress, ElementText);
				}
				else if (const FNameProperty* InnerName = CastField<FNameProperty>(ArrayProperty->Inner))
				{
					InnerName->SetPropertyValue(ElementAddress, FName(*ElementText));
				}
				else if (const FTextProperty* InnerText = CastField<FTextProperty>(ArrayProperty->Inner))
				{
					InnerText->SetPropertyValue(ElementAddress, FText::FromString(ElementText));
				}
			}

			++Context.Stats.Applied;
			return true;
		}

		++Context.Stats.Failed;
		Context.Warn(FString::Printf(TEXT("%s: property '%s' of type %s is not supported by the reflection writer"),
			*Context.Prefix, *Property->GetName(), *TypeName));
		return false;
	}
}

bool FHtml2UMGPropertyApplier::HasAnyField(const TSharedPtr<FJsonObject>& Object, const TArray<FString>& FieldNames)
{
	if (!Object.IsValid() || FieldNames.Num() == 0)
	{
		return false;
	}

	TArray<FJsonField> Fields;
	CollectFields(Object, Fields);

	for (const FJsonField& Field : Fields)
	{
		for (const FString& Wanted : FieldNames)
		{
			if (Field.Name.Equals(Wanted, ESearchCase::IgnoreCase))
			{
				return true;
			}
		}
	}

	return false;
}

void FH2UApplyStats::Accumulate(const FH2UApplyStats& Other)
{
	Applied += Other.Applied;
	UnknownKeys += Other.UnknownKeys;
	Failed += Other.Failed;
	Skipped += Other.Skipped;
}

FProperty* FHtml2UMGPropertyApplier::FindProperty(UClass* Class, const FString& Name)
{
	if (!Class || Name.IsEmpty())
	{
		return nullptr;
	}

	const FName ExactName(*Name);
	if (FProperty* Exact = FindFProperty<FProperty>(Class, ExactName))
	{
		return Exact;
	}

	for (TFieldIterator<FProperty> It(Class); It; ++It)
	{
		if (It->GetName().Equals(Name, ESearchCase::IgnoreCase))
		{
			return *It;
		}
	}

	// "AutoSize" -> "bAutoSize" (and the reverse): UE's b-prefix is not part of the layout contract.
	const FString AlternateName = AlternatePropertyName(Name);
	if (!AlternateName.IsEmpty())
	{
		if (FProperty* Alternate = FindFProperty<FProperty>(Class, FName(*AlternateName)))
		{
			return Alternate;
		}

		for (TFieldIterator<FProperty> It(Class); It; ++It)
		{
			if (It->GetName().Equals(AlternateName, ESearchCase::IgnoreCase))
			{
				return *It;
			}
		}
	}

	return nullptr;
}

FProperty* FHtml2UMGPropertyApplier::FindStructProperty(const UScriptStruct* Struct, const FString& Name)
{
	if (!Struct || Name.IsEmpty())
	{
		return nullptr;
	}

	const FName ExactName(*Name);
	if (FProperty* Exact = FindFProperty<FProperty>(Struct, ExactName))
	{
		return Exact;
	}

	for (TFieldIterator<FProperty> It(Struct); It; ++It)
	{
		if (It->GetName().Equals(Name, ESearchCase::IgnoreCase))
		{
			return *It;
		}
	}

	// Same b-prefix leniency, for struct members (bAutoSize, bIsEnabled, ...).
	const FString AlternateName = AlternatePropertyName(Name);
	if (!AlternateName.IsEmpty())
	{
		if (FProperty* Alternate = FindFProperty<FProperty>(Struct, FName(*AlternateName)))
		{
			return Alternate;
		}

		for (TFieldIterator<FProperty> It(Struct); It; ++It)
		{
			if (It->GetName().Equals(AlternateName, ESearchCase::IgnoreCase))
			{
				return *It;
			}
		}
	}

	return nullptr;
}

FString FHtml2UMGPropertyApplier::DescribePropertyType(const FProperty* Property)
{
	if (!Property)
	{
		return TEXT("<null>");
	}

	if (const FStructProperty* StructProperty = CastField<FStructProperty>(Property))
	{
		return StructProperty->Struct ? StructProperty->Struct->GetName() : TEXT("struct");
	}

	if (const FObjectProperty* ObjectProperty = CastField<FObjectProperty>(Property))
	{
		return ObjectProperty->PropertyClass ? ObjectProperty->PropertyClass->GetName() : TEXT("object");
	}

	if (const FEnumProperty* EnumProperty = CastField<FEnumProperty>(Property))
	{
		return EnumProperty->GetEnum() ? EnumProperty->GetEnum()->GetName() : TEXT("enum");
	}

	if (const FByteProperty* ByteProperty = CastField<FByteProperty>(Property))
	{
		return ByteProperty->Enum ? ByteProperty->Enum->GetName() : TEXT("uint8");
	}

	if (CastField<FBoolProperty>(Property))
	{
		return TEXT("bool");
	}

	if (CastField<FStrProperty>(Property))
	{
		return TEXT("FString");
	}

	if (CastField<FNameProperty>(Property))
	{
		return TEXT("FName");
	}

	if (CastField<FTextProperty>(Property))
	{
		return TEXT("FText");
	}

	if (CastField<FSoftObjectProperty>(Property))
	{
		return TEXT("soft object");
	}

	if (CastField<FArrayProperty>(Property))
	{
		return TEXT("TArray");
	}

	return Property->GetCPPType();
}

FH2UApplyStats FHtml2UMGPropertyApplier::ApplyJsonObject(
	UObject* Target,
	const TSharedPtr<FJsonObject>& Values,
	const FH2UObjectResolver& Resolver,
	const FH2UMessageSink& Sink,
	const FString& Context)
{
	FApplyContext Ctx;
	Ctx.Resolver = &Resolver;
	Ctx.Sink = &Sink;
	Ctx.Prefix = Context;

	if (!Target)
	{
		Ctx.Message(TEXT("error"), FString::Printf(TEXT("%s: cannot apply properties, target object is null."), *Context));
		return Ctx.Stats;
	}

	if (!Values.IsValid())
	{
		return Ctx.Stats;
	}

	UClass* Class = Target->GetClass();
	TArray<FJsonField> Fields;
	CollectFields(Values, Fields);

	for (const FJsonField& Field : Fields)
	{
		const TSharedPtr<FJsonValue> Value = Field.Value;
		FProperty* Property = FindProperty(Class, Field.Name);
		if (!Property)
		{
			++Ctx.Stats.UnknownKeys;
			Ctx.Warn(FString::Printf(TEXT("%s: '%s' is not a property of %s"), *Context, *Field.Name, *Class->GetName()));
			continue;
		}

		if (!Value.IsValid() || Value->Type == EJson::Null || Value->Type == EJson::None)
		{
			++Ctx.Stats.Skipped;
			continue;
		}

		if (!Property->HasAnyPropertyFlags(CPF_Edit | CPF_BlueprintVisible))
		{
			// Still writable through reflection; only note it in the log, not in the user-facing messages.
			UE_LOG(LogHtml2UMG, Verbose, TEXT("Html2UMG: %s: writing non-editable property '%s' on %s"),
				*Context, *Field.Name, *Class->GetName());
		}

		const int32 AppliedBefore = Ctx.Stats.Applied;
		ApplyPropertyValue(Target, Property, Value, Ctx);

		if (Ctx.Stats.Applied > AppliedBefore)
		{
			// USizeBox (and anything else using UE's bOverride_<Property> gate) ignores the value until
			// the bit is set: USizeBox::SynchronizeProperties only forwards MinDesiredWidth to Slate
			// when bOverride_MinDesiredWidth is true, so a layout that carries only "MinDesiredWidth"
			// would pass import without ever clamping anything at runtime.
			const FString Name = Property->GetName();
			if (!Name.StartsWith(TEXT("bOverride_"), ESearchCase::IgnoreCase))
			{
				const FName OverrideName(*FString::Printf(TEXT("bOverride_%s"), *Name));
				if (const FBoolProperty* OverrideBit = CastField<FBoolProperty>(FindFProperty<FProperty>(Class, OverrideName)))
				{
					OverrideBit->SetPropertyValue_InContainer(Target, true);
					++Ctx.Stats.Applied;
					UE_LOG(LogHtml2UMG, Verbose, TEXT("Html2UMG: %s: implied '%s' = true from '%s'"), *Context, *OverrideName.ToString(), *Name);
				}
			}
		}
	}

	return Ctx.Stats;
}

FH2UApplyStats FHtml2UMGPropertyApplier::ApplyBrush(
	UObject* Widget,
	const TSharedPtr<FJsonObject>& BrushJson,
	const FH2UBrushContext& BrushContext,
	const FH2UObjectResolver& Resolver,
	const FH2UMessageSink& Sink,
	const FString& Context)
{
	FApplyContext Ctx;
	Ctx.Resolver = &Resolver;
	Ctx.Sink = &Sink;
	Ctx.BrushOptions = &BrushContext;
	Ctx.Prefix = Context;

	if (!Widget)
	{
		Ctx.Message(TEXT("error"), FString::Printf(TEXT("%s: cannot apply brush, widget is null."), *Context));
		return Ctx.Stats;
	}

	if (!BrushJson.IsValid())
	{
		return Ctx.Stats;
	}

	FSlateBrush Brush = FSlateBrush();
	if (!BuildBrushFromJson(Brush, BrushJson, Ctx))
	{
		++Ctx.Stats.Failed;
	}

	if (UBorder* Border = Cast<UBorder>(Widget))
	{
		Border->SetBrush(Brush);
		++Ctx.Stats.Applied;
		return Ctx.Stats;
	}

	if (UImage* Image = Cast<UImage>(Widget))
	{
		Image->SetBrush(Brush);
		++Ctx.Stats.Applied;
		return Ctx.Stats;
	}

	if (UButton* Button = Cast<UButton>(Widget))
	{
		FButtonStyle Style = Button->GetStyle();
		Style.Normal = Brush;
		Style.Hovered = Brush;
		Style.Pressed = Brush;
		Style.Disabled = Brush;

		// Optional per-state overrides: brush.states.{hovered, pressed, disabled}. The converter
		// derives them from the page's :hover / :active / :disabled rules, so hovering actually
		// changes the button the way the design does.
		int32 StateCount = 0;
		const TSharedPtr<FJsonObject>* StatesObject = nullptr;
		if (BrushJson->TryGetObjectField(TEXT("states"), StatesObject) && StatesObject && (*StatesObject).IsValid())
		{
			const TPair<const TCHAR*, FSlateBrush*> StateBindings[] =
			{
				TPair<const TCHAR*, FSlateBrush*>(TEXT("hovered"), &Style.Hovered),
				TPair<const TCHAR*, FSlateBrush*>(TEXT("pressed"), &Style.Pressed),
				TPair<const TCHAR*, FSlateBrush*>(TEXT("disabled"), &Style.Disabled),
			};

			for (const TPair<const TCHAR*, FSlateBrush*>& Binding : StateBindings)
			{
				const TSharedPtr<FJsonObject>* StateJson = nullptr;
				if (!(*StatesObject)->TryGetObjectField(Binding.Key, StateJson) || !StateJson || !(*StateJson).IsValid())
				{
					continue;
				}

				FSlateBrush StateBrush = Brush;
				if (BuildBrushFromJson(StateBrush, *StateJson, Ctx))
				{
					*Binding.Value = StateBrush;
					++StateCount;
				}
			}
		}

		Button->SetStyle(Style);
		++Ctx.Stats.Applied;
		if (StateCount > 0)
		{
			Ctx.Info(FString::Printf(TEXT("%s: button brush applied with %d interaction state(s) from the design"),
				*Context, StateCount));
		}
		else
		{
			Ctx.Info(FString::Printf(TEXT("%s: button brush applied to Normal/Hovered/Pressed/Disabled (the design declares no interaction states)"), *Context));
		}
		return Ctx.Stats;
	}

	++Ctx.Stats.Failed;
	Ctx.Warn(FString::Printf(TEXT("%s: a brush block was given for %s, which has no FSlateBrush slot (supported: Border, Image, Button)"),
		*Context, *Widget->GetClass()->GetName()));
	return Ctx.Stats;
}
