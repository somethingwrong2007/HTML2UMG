// Copyright (c) 2026 FPVSkyline. MIT License.
//
// Headless verification of the importer: parses a hand-written layout.json, runs
// FHtml2UMGImporter::ImportLayout and inspects the resulting Widget Blueprint.
//
// Run with:
//   UnrealEditor-Cmd.exe FPVSkyline.uproject -ExecCmds="Automation RunTests Html2UMG" -unattended -nullrhi
// or in the editor: Tools > Test Automation > "Html2UMG.Import.SampleLayout".

#include "CoreMinimal.h"
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetTree.h"
#include "Components/Border.h"
#include "Components/CanvasPanel.h"
#include "Components/CanvasPanelSlot.h"
#include "Components/TextBlock.h"
#include "Components/VerticalBox.h"
#include "Components/VerticalBoxSlot.h"
#include "HAL/FileManager.h"
#include "Html2UMGTypes.h"
#include "Importer/Html2UMGImporter.h"
#include "ObjectTools.h"
#include "Styling/SlateBrush.h"
#include "WidgetBlueprint.h"

namespace
{
	const TCHAR* const kAutoTestBlueprintPath = TEXT("/Game/Html2UMG/Tests/WBP_Html2UMG_AutoTest");

	/**
	 * A layout that exercises every branch of the importer that matters:
	 * panels, a content widget, slots of two different classes, struct properties,
	 * an enum by name, a linear colour, and a rounded brush.
	 */
	const TCHAR* const kAutoTestLayoutJson = TEXT(R"JSON(
{
  "contractVersion": 1,
  "generator": "html2umg-converter/automation",
  "source": "inline-automation",
  "blueprint": "/Game/Html2UMG/Tests/WBP_Html2UMG_AutoTest",
  "viewport": { "width": 1920, "height": 1080 },
  "assets": { "textures": [], "fonts": [] },
  "warnings": [],
  "root": {
    "name": "RootCanvas",
    "class": "CanvasPanel",
    "variable": true,
    "children": [
      {
        "name": "MainPanel",
        "class": "VerticalBox",
        "slot": {
          "LayoutData": {
            "Anchors": { "Minimum": [0, 0], "Maximum": [1, 1] },
            "Offsets": { "Left": 0, "Top": 0, "Right": 0, "Bottom": 0 },
            "Alignment": [0, 0]
          },
          "AutoSize": false,
          "ZOrder": 1
        },
        "children": [
          {
            "name": "TitleText",
            "class": "TextBlock",
            "properties": {
              "Text": "SYSTEM READY",
              "Font": { "Size": 18.0, "TypefaceFontName": "Regular", "LetterSpacing": 0 },
              "ColorAndOpacity": [0.05, 0.05, 0.06, 1.0],
              "Justification": "Left",
              "AutoWrapText": true,
              "ShadowOffset": [1.0, 1.0],
              "ShadowColorAndOpacity": [0.0, 0.0, 0.0, 0.5]
            },
            "slot": {
              "Padding": [0, 8, 0, 8],
              "Size": { "Value": 1.0, "SizeRule": "Automatic" },
              "HorizontalAlignment": "Fill",
              "VerticalAlignment": "Center"
            }
          },
          {
            "name": "CardBorder",
            "class": "Border",
            "brush": {
              "drawAs": "RoundedBox",
              "tint": [0.1, 0.12, 0.16, 1.0],
              "cornerRadii": [8, 8, 8, 8],
              "outlineWidth": 1.0,
              "outlineColor": [1.0, 1.0, 1.0, 0.15]
            },
            "slot": { "Padding": [4, 4, 4, 4] },
            "children": [
              {
                "name": "BodyText",
                "class": "TextBlock",
                "variable": false,
                "properties": { "Text": "ONLINE" }
              }
            ]
          }
        ]
      }
    ]
  }
}
)JSON");
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHtml2UMGImportSampleLayoutTest,
	"Html2UMG.Import.SampleLayout",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHtml2UMGImportSampleLayoutTest::RunTest(const FString& Parameters)
{
	// ---- 1. contract parsing ----
	FH2ULayout Layout;
	TArray<FH2UMessage> ParseMessages;
	const bool bParsed = FH2ULayout::ParseFromString(kAutoTestLayoutJson, FPaths::ProjectDir(), Layout, ParseMessages);
	for (const FH2UMessage& Message : ParseMessages)
	{
		if (Message.IsError())
		{
			AddError(FString::Printf(TEXT("parse: %s"), *Message.Text));
		}
	}
	if (!TestTrue(TEXT("layout.json parses"), bParsed))
	{
		return false;
	}

	// ---- 2. import ----
	FH2UImportOptions Options;
	Options.BlueprintPath = kAutoTestBlueprintPath;
	Options.AssetOutputRoot = TEXT("/Game/Html2UMG/Tests");
	Options.bImportTextures = false;
	Options.bImportFonts = false;
	Options.bReimportInPlace = true;
	Options.bCompile = true;
	Options.bSave = false; // keep the project folder clean; the asset is deleted at the end

	FH2UImportResult Result;
	const bool bImported = FHtml2UMGImporter::ImportLayout(Layout, Options, Result);

	for (const FH2UMessage& Message : Result.Messages)
	{
		if (Message.IsError())
		{
			AddError(FString::Printf(TEXT("import: %s"), *Message.Text));
		}
	}

	TestTrue(TEXT("ImportLayout succeeds"), bImported);
	TestEqual(TEXT("no errors reported"), Result.ErrorCount(), 0);
	TestEqual(TEXT("5 widgets created"), Result.WidgetsCreated, 5);
	TestTrue(TEXT("properties were written"), Result.PropertiesSet > 0);
	TestEqual(TEXT("blueprint path is reported"), Result.BlueprintPath, FString(kAutoTestBlueprintPath));

	// ---- 3. inspect the produced asset ----
	UWidgetBlueprint* Blueprint = LoadObject<UWidgetBlueprint>(nullptr,
		TEXT("/Game/Html2UMG/Tests/WBP_Html2UMG_AutoTest.WBP_Html2UMG_AutoTest"));

	if (!TestNotNull(TEXT("the Widget Blueprint asset exists"), Blueprint))
	{
		return false;
	}

	if (!TestNotNull(TEXT("the blueprint has a widget tree"), Blueprint->WidgetTree.Get()))
	{
		return false;
	}

	UWidgetTree* Tree = Blueprint->WidgetTree;

	UWidget* RootWidget = Tree->RootWidget;
	if (TestNotNull(TEXT("the tree has a root widget"), RootWidget))
	{
		TestTrue(TEXT("root is a CanvasPanel"), RootWidget->IsA<UCanvasPanel>());
		TestEqual(TEXT("root keeps its name"), RootWidget->GetName(), FString(TEXT("RootCanvas")));
	}

	TArray<UWidget*> AllWidgets;
	Tree->GetAllWidgets(AllWidgets);
	TestEqual(TEXT("the tree holds exactly 5 widgets"), AllWidgets.Num(), 5);

	// -- slot + properties on the VerticalBox --
	UVerticalBox* MainPanel = Cast<UVerticalBox>(Tree->FindWidget(TEXT("MainPanel")));
	if (TestNotNull(TEXT("MainPanel exists and is a VerticalBox"), MainPanel))
	{
		if (const UCanvasPanelSlot* CanvasSlot = Cast<UCanvasPanelSlot>(MainPanel->Slot))
		{
			TestEqual(TEXT("canvas slot ZOrder was written"), CanvasSlot->GetZOrder(), 1);
			const FAnchors Anchors = CanvasSlot->GetAnchors();
			TestTrue(TEXT("canvas slot anchors were written"), FMath::IsNearlyEqual(Anchors.Maximum.Y, 1.0));
		}
		else
		{
			AddError(TEXT("MainPanel should be hosted by a CanvasPanelSlot."));
		}
	}

	// -- properties on the TextBlock --
	UTextBlock* Title = Cast<UTextBlock>(Tree->FindWidget(TEXT("TitleText")));
	if (TestNotNull(TEXT("TitleText exists and is a TextBlock"), Title))
	{
		TestEqual(TEXT("Text was written"), Title->GetText().ToString(), FString(TEXT("SYSTEM READY")));
		TestTrue(TEXT("AutoWrapText was written"), Title->GetAutoWrapText());
		TestTrue(TEXT("Font.Size was written"), FMath::IsNearlyEqual(Title->GetFont().Size, 18.0f));
		TestEqual(TEXT("TypefaceFontName was written"), Title->GetFont().TypefaceFontName.ToString(), FString(TEXT("Regular")));

		if (const UVerticalBoxSlot* BoxSlot = Cast<UVerticalBoxSlot>(Title->Slot))
		{
			TestTrue(TEXT("slot padding was written"), FMath::IsNearlyEqual(BoxSlot->GetPadding().Top, 8.0f));
			TestEqual(TEXT("slot size rule was written"), static_cast<int32>(BoxSlot->GetSize().SizeRule.GetValue()), static_cast<int32>(ESlateSizeRule::Automatic));
		}
		else
		{
			AddError(TEXT("TitleText should be hosted by a VerticalBoxSlot."));
		}
	}

	// -- brush on the Border --
	UBorder* Card = Cast<UBorder>(Tree->FindWidget(TEXT("CardBorder")));
	if (TestNotNull(TEXT("CardBorder exists and is a Border"), Card))
	{
		const FSlateBrush& Brush = Card->Background;
		TestEqual(TEXT("brush drawAs is RoundedBox"), static_cast<int32>(Brush.GetDrawType()), static_cast<int32>(ESlateBrushDrawType::RoundedBox));
		TestTrue(TEXT("brush corner radius was written"), FMath::IsNearlyEqual(Brush.OutlineSettings.CornerRadii.X, 8.0f));
		TestTrue(TEXT("brush outline width was written"), FMath::IsNearlyEqual(Brush.OutlineSettings.Width, 1.0f));
		TestTrue(TEXT("brush tint is linear"), FMath::IsNearlyEqual(Brush.TintColor.GetSpecifiedColor().B, 0.16f, 0.001f));
	}

	// -- variable flags --
	if (UTextBlock* Body = Cast<UTextBlock>(Tree->FindWidget(TEXT("BodyText"))))
	{
		TestFalse(TEXT("variable:false is honoured"), Body->bIsVariable != 0);
	}
	else
	{
		AddError(TEXT("BodyText was not created."));
	}

	// ---- 4. reimport in place: widget identity must survive ----
	const int32 FirstCreationCount = Result.WidgetsCreated;

	FH2UImportResult SecondResult;
	FHtml2UMGImporter::ImportLayout(Layout, Options, SecondResult);

	TestEqual(TEXT("reimport reports no errors"), SecondResult.ErrorCount(), 0);
	TestEqual(TEXT("reimport reuses every widget"), SecondResult.WidgetsReused, FirstCreationCount);
	TestEqual(TEXT("reimport creates no new widgets"), SecondResult.WidgetsCreated, 0);

	if (UWidgetTree* RebuiltTree = Blueprint->WidgetTree.Get())
	{
		TArray<UWidget*> RebuiltWidgets;
		RebuiltTree->GetAllWidgets(RebuiltWidgets);
		TestEqual(TEXT("reimport keeps the widget count stable"), RebuiltWidgets.Num(), 5);
		TestTrue(TEXT("reimport keeps the root widget"), RebuiltTree->RootWidget != nullptr);
	}

	// ---- 5. clean up the test asset ----
	if (UObject* TestAsset = LoadObject<UObject>(nullptr,
		TEXT("/Game/Html2UMG/Tests/WBP_Html2UMG_AutoTest.WBP_Html2UMG_AutoTest")))
	{
		ObjectTools::DeleteSingleObject(TestAsset, /*bShowConfirmation=*/false);
	}

	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
