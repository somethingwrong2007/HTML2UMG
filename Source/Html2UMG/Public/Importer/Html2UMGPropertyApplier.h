// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Html2UMGTypes.h"
#include "Templates/Function.h"

class FProperty;
class UClass;
class UObject;

/**
 * Resolves a layout asset reference ("@key", "/Game/Foo", absolute path) into a loaded UObject.
 * ExpectedClass is the class the target property wants (may be null when unknown).
 * Return null to report that the reference could not be resolved; the applier emits a warning.
 */
using FH2UObjectResolver = TFunction<UObject*(const FString& /*Reference*/, UClass* /*ExpectedClass*/, const FString& /*Context*/)>;

/** Receives one severity-tagged message ("info" | "warning" | "error"). */
using FH2UMessageSink = TFunction<void(const FH2UMessage&)>;

/** What a single property-application pass did. */
struct HTML2UMG_API FH2UApplyStats
{
	/** Properties that were written successfully. */
	int32 Applied = 0;
	/** JSON keys that do not exist on the target class/struct. */
	int32 UnknownKeys = 0;
	/** Keys that matched a property but could not be written (bad value shape/type). */
	int32 Failed = 0;
	/** Keys deliberately ignored (null value, read-only property, ...). */
	int32 Skipped = 0;

	void Accumulate(const FH2UApplyStats& Other);
	int32 Total() const { return Applied + UnknownKeys + Failed + Skipped; }
};

/** Extra information needed to turn a contract §4 brush block into an FSlateBrush. */
struct HTML2UMG_API FH2UBrushContext
{
	/** Size the widget is expected to have on screen; (0,0) means "unknown", which disables radius clamping. */
	FVector2D WidgetSize = FVector2D::ZeroVector;
	/** Emit an info message when a brush key is understood but has no direct FSlateBrush equivalent. */
	bool bVerbose = true;
};

/**
 * Generic reflection writer: turns contract §3 JSON values into UPROPERTY writes on any UObject
 * (widgets, slots, ...) and handles the §4 brush block for Border / Image / Button.
 *
 * Supported property types:
 *   FBoolProperty, FIntProperty, FInt64Property, FByteProperty, FFloatProperty, FDoubleProperty,
 *   FStrProperty, FNameProperty, FTextProperty, FEnumProperty (by name or value),
 *   FObjectProperty / FClassProperty / FSoftObjectProperty (via FH2UObjectResolver),
 *   FStructProperty (recursive, with specialisations for the Slate/UMG math structs).
 *
 * Not supported (reported as a warning, never silently ignored):
 *   TArray, TMap, TSet, delegates, interfaces, weak/lazy object pointers.
 */
class HTML2UMG_API FHtml2UMGPropertyApplier
{
public:
	/**
	 * Writes every key of Values onto Target.
	 * Context is a short prefix for messages, e.g. "Node 'TitleText' properties".
	 */
	static FH2UApplyStats ApplyJsonObject(
		UObject* Target,
		const TSharedPtr<FJsonObject>& Values,
		const FH2UObjectResolver& Resolver,
		const FH2UMessageSink& Sink,
		const FString& Context);

	/**
	 * Writes a contract §4 brush block onto a widget that owns an FSlateBrush
	 * (UBorder, UImage, or UButton - which receives it as its Normal/Hovered/Pressed/Disabled style).
	 */
	static FH2UApplyStats ApplyBrush(
		UObject* Widget,
		const TSharedPtr<FJsonObject>& BrushJson,
		const FH2UBrushContext& BrushContext,
		const FH2UObjectResolver& Resolver,
		const FH2UMessageSink& Sink,
		const FString& Context);

	/** Case-insensitive property lookup on a class (exact-name fast path first). */
	static FProperty* FindProperty(UClass* Class, const FString& Name);

	/** Case-insensitive property lookup on a script struct. */
	static FProperty* FindStructProperty(const UScriptStruct* Struct, const FString& Name);

	/** Human readable type name for diagnostics, e.g. "float" or "FVector2D". */
	static FString DescribePropertyType(const FProperty* Property);

	/**
	 * True when the JSON object has at least one of the given field names (case-insensitive).
	 * Used to decide whether a widget needs SynchronizeProperties() after a write.
	 */
	static bool HasAnyField(const TSharedPtr<FJsonObject>& Object, const TArray<FString>& FieldNames);
};
