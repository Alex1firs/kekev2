import os
from PIL import Image

# Target directory (user's desktop)
desktop_path = "/Users/nwabufohalex/Desktop"

# Color matching the app's dark charcoal background (#1A1A24)
bg_color = (26, 26, 36)

# Desired 10-inch tablet size (1600 x 2560 px, 10:16 aspect ratio)
canvas_size = (1600, 2560)

screenshots = [
    "passengerfirst_andriod.png",
    "passengersecond_andriod.png",
    "passengerthird_andriod.png",
    "passenger4_andriod.png",
    "passenger5_andriod.png"
]

for filename in screenshots:
    input_path = os.path.join(desktop_path, filename)
    if not os.path.exists(input_path):
        print(f"Skipping {filename}: not found on Desktop")
        continue

    # Load original phone screenshot
    img = Image.open(input_path)
    
    # Create the background canvas
    canvas = Image.new("RGB", canvas_size, bg_color)
    
    # Calculate scale factor to make the phone screenshot fit beautifully in the center
    # We want the phone screenshot to occupy about 75% of the 10-inch canvas height
    target_height = int(canvas_size[1] * 0.75)
    aspect_ratio = img.width / img.height
    target_width = int(target_height * aspect_ratio)
    
    # Resize the screenshot using high-quality resampling
    resized_img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
    
    # Paste the resized screenshot directly in the center of the canvas
    paste_x = (canvas_size[0] - target_width) // 2
    paste_y = (canvas_size[1] - target_height) // 2
    canvas.paste(resized_img, (paste_x, paste_y))
    
    # Save the beautiful finished 10-inch tablet screenshot
    output_filename = filename.replace("_andriod", "_10inch").replace("4_andriod", "4_10inch").replace("5_andriod", "5_10inch")
    output_path = os.path.join(desktop_path, output_filename)
    canvas.save(output_path, "PNG")
    print(f"Successfully generated: {output_filename}")

print("All 10-inch tablet screenshots generated on your Desktop!")
