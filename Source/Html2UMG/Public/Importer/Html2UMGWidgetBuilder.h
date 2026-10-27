// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Html2UMGTypes.h"
#include "Importer/Html2UMGAssetImport.h"
#include "Importer/Html2UMGPropertyApplier.h"

class UClass;
class UPanelSlot;
class UWidget;
class UWidgetTree;

/**
 * Turns a parsed FH2UNode tree into UMG widgets inside an existing UWidgetTree.
 *
 * Responsibilities:
 *   - class resolution ("VerticalBox" / "/Script/UMG.VerticalBox" / "/Game/.../WBP_Foo.WBP_Foo_C")
 *   - widget construction and parenting (UPanelWidget::AddChild / UContentWidget::SetContent)
 *   - writing "properties", "slot" and "brush" through the reflection writer
 *   - in-place rebuild: existing widgets with the same name and class are reused, so widget
 *     identity (and therefore BindWidget wiring and designer references) survives a reimport.
 */
class HTML2UMG_API FHtml2UMGWidgetBuilder
{
public:
	FHtml2UMGWidgetBuilder(UWidgetTree& InWidgetTree, FHtml2UMGAssetImport& InAssets, const FH2UImportOptions& InOptions, const FVector2D& InDesignViewport);

	void SetMessageSink(const FH2UMessageSink& InSink) { Sink = InSink; }

	/**
	 * Builds the node and its children into the tree.
	 * bReuseExisting enables the in-place rebuild path (reuse by name+class, retire the rest).
	 * Returns the root widget, or null when the node could not be created.
	 */
	UWidget* Build(const FH2UNode& RootNode, bool bReuseExisting);

	int32 WidgetsCreated = 0;
	int32 WidgetsReused = 0;
	int32 PropertiesSet = 0;
	int32 UnknownProperties = 0;
	int32 FailedProperties = 0;

	/** Resolves a UMG class from a layout class name. OutError gets a suggestion when it fails. */
	static UClass* ResolveWidgetClass(const FString& ClassName, FString& OutError);

	/** "TextBlok" -> "TextBlock"; empty when nothing is close enough. */
	static FString SuggestWidgetClass(const FString& ClassName);

private:
	UWidget* BuildNode(const FH2UNode& Node, UWidget* ParentWidget, int32 Depth);
	UWidget* AcquireWidget(const FH2UNode& Node, UClass* WidgetClass, FName DesiredName);
	UPanelSlot* AttachToParent(UWidget& Widget, UWidget* ParentWidget, const FH2UNode& Node);
	/** Returns how many properties were written (drives the one SynchronizeProperties() per widget). */
	int32 ApplyProperties(const FH2UNode& Node, UWidget& Widget);
	void ApplySlot(const FH2UNode& Node, UPanelSlot* Slot);
	int32 ApplyBrushBlock(const FH2UNode& Node, UWidget& Widget);

	/**
	 * Clears the UMG factory defaults the layout JSON never asked for, after the JSON has been applied:
	 *   - UBorder's Padding = FMargin(4,2) and its "no brush" default (a solid white box)
	 *   - UComboBoxString's Slate-default dropdown frame (MenuBorderBrush / MenuBorderPadding)
	 *   - widget-level colour tints that would be multiplied a second time into a baked texture
	 *     (FCheckBoxStyle foreground colours, USlider bar/handle colours)
	 * Returns how many properties were written, so the caller still calls SynchronizeProperties().
	 */
	int32 NormalizeWidgetDefaults(const FH2UNode& Node, UWidget& Widget);

	/** Best-effort pixel size of a node, used to clamp brush corner radii. */
	FVector2D EstimateWidgetSize(const FH2UNode& Node) const;

	void Message(const TCHAR* Severity, const FString& Text);
	void Warn(const FString& Text) { Message(TEXT("warning"), Text); }
	void Info(const FString& Text) { Message(TEXT("info"), Text); }
	void Error(const FString& Text) { Message(TEXT("error"), Text); }

	FString NodeContext(const FH2UNode& Node) const;

	void PrepareInPlaceRebuild();
	void PrepareCleanRebuild();
	void RetireUnusedWidgets();
	void RetireWidget(UWidget* Widget);

	UWidgetTree& Tree;
	FHtml2UMGAssetImport& Assets;
	const FH2UImportOptions& Options;
	const FVector2D DesignViewport;
	FH2UMessageSink Sink;

	/** Old widgets by name, captured before the rebuild started. */
	TMap<FName, UWidget*> OldWidgetsByName;
	TArray<UWidget*> OldWidgets;
	TSet<UWidget*> ConsumedWidgets;
	TSet<FName> UsedNames;

	bool bRebuildInPlace = false;
	int32 RetirementCounter = 0;
	int32 DepthGuard = 0;
};
