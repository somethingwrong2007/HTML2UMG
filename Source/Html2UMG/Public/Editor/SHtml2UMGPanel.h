// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Input/Reply.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/DeclarativeSyntaxSupport.h"

#include "Editor/Html2UMGConverter.h"
#include "Html2UMGTypes.h"

class SEditableTextBox;
class SCheckBox;
class SScrollBox;
class SVerticalBox;
class STextBlock;

/**
 * The HTML -> UMG workbench tab.
 *
 * Layout: source/blueprint/viewport inputs, import toggles, three actions and a
 * severity-coloured log. The node conversion runs on the thread pool; every UObject
 * touch (import, render, UI updates) is marshalled back to the game thread.
 */
class HTML2UMG_API SHtml2UMGPanel : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SHtml2UMGPanel)
		: _InitialFilePath()
	{}
		/** Optional path to pre-fill: *.html goes to the source field, *.json to the layout field. */
		SLATE_ARGUMENT(FString, InitialFilePath)
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs);

	/** Pre-fills the html or json field, depending on the extension. */
	void SetInitialFilePath(const FString& InPath);

	/** Appends one line to the log view. Safe from any thread (marshals to the game thread). */
	void AppendLog(const FString& InMessage, const FString& InSeverity = TEXT("info"));

	/** Empties the log view. */
	void ClearLog();

private:
	enum class EOperation : uint8
	{
		None,
		Convert,
		ConvertAndImport,
		Import,
	};

	// ---- action handlers -------------------------------------------------
	FReply OnBrowseHtmlClicked();
	FReply OnBrowseJsonClicked();
	FReply OnConvertClicked();
	FReply OnConvertAndImportClicked();
	FReply OnImportJsonClicked();
	FReply OnClearLogClicked();

	// ---- async chain -----------------------------------------------------
	void StartConvert(bool bImportAfterwards);
	void OnConvertFinished(const FH2UConvertResult& ConvertResult, bool bImportAfterwards);
	void StartImport();
	void OnImportFinished(const FH2UImportResult& ImportResult);

	// ---- state queries ---------------------------------------------------
	bool IsIdle() const { return CurrentOperation == EOperation::None; }
	FText GetStatusText() const;
	FString GetHtmlPath() const;
	FString GetJsonPath() const;
	FString GetBlueprintPath() const;
	FVector2D GetViewport() const;
	bool IsChecked(const TSharedPtr<SCheckBox>& CheckBox, bool bFallback) const;

	// ---- helpers ---------------------------------------------------------
	void SetOperation(EOperation NewOperation);
	void LogLinesFromText(const FString& Text, const FString& Severity);
	void SuggestJsonPathFor(const FString& HtmlPath);

private:
	TSharedPtr<SEditableTextBox> HtmlPathBox;
	TSharedPtr<SEditableTextBox> JsonPathBox;
	TSharedPtr<SEditableTextBox> BlueprintPathBox;
	TSharedPtr<SEditableTextBox> ViewportWidthBox;
	TSharedPtr<SEditableTextBox> ViewportHeightBox;

	TSharedPtr<SCheckBox> ImportTexturesCheck;
	TSharedPtr<SCheckBox> ImportFontsCheck;
	TSharedPtr<SCheckBox> ReimportInPlaceCheck;
	TSharedPtr<SCheckBox> CompileCheck;
	TSharedPtr<SCheckBox> SaveCheck;

	TSharedPtr<SVerticalBox> LogLines;
	TSharedPtr<SScrollBox> LogScroll;

	EOperation CurrentOperation = EOperation::None;
	int32 LogLineCount = 0;

	/** Seconds before the node subprocess is killed; mirrored into FH2UConvertOptions. */
	int32 ConvertTimeoutSeconds = 30;
};
